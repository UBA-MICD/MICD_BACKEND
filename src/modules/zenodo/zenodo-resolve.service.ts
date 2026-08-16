import { zenodoClient } from "../../clients/zenodo.client";
import { type ZenodoEnvironment, getStoredToken } from "./zenodo.service";
import { throttle } from "./zenodo-rate-limit.service";
import { getZenodoRecord, type ZenodoRecordDetail } from "./zenodo-search.service";

export interface ParsedZenodoInput {
  recordId: number;
  environment: ZenodoEnvironment;
}

// Ticket ZEN-09's own validation regex: 10.\d{4,}/zenodo.\d+ — optionally
// prefixed with a doi.org resolver URL or a bare "doi:" scheme.
const DOI_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,}\/zenodo\.(\d+))$/i;
// Accepts both the current "/records/:id" and the older singular "/record/:id".
const URL_RE = /^https?:\/\/(sandbox\.)?zenodo\.org\/records?\/(\d+)(?:[/?#].*)?$/i;

/**
 * Parses a pasted Zenodo DOI or record URL into a record id + environment.
 * Returns null for anything that doesn't match either shape — malformed
 * input and DOIs from other repositories both fail the same way here.
 */
export function parseZenodoInput(raw: string): ParsedZenodoInput | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const doiMatch = trimmed.match(DOI_RE);
  if (doiMatch) {
    const doi = doiMatch[1].toLowerCase();
    return {
      recordId: parseInt(doiMatch[2], 10),
      environment: doi.startsWith("10.5072/") ? "sandbox" : "production",
    };
  }

  const urlMatch = trimmed.match(URL_RE);
  if (urlMatch) {
    return {
      recordId: parseInt(urlMatch[2], 10),
      environment: urlMatch[1] ? "sandbox" : "production",
    };
  }

  return null;
}

export interface VersionInfo {
  recordId: number;
  doi: string | null;
  version: string | null;
  publicationDate: string | null;
  isLatest: boolean;
  isSelected: boolean;
}

export interface ResolvedZenodoRecord {
  record: ZenodoRecordDetail;
  versions: VersionInfo[];
  environment: ZenodoEnvironment;
}

/** Resolves an already-parsed record id to its detail plus its sibling versions (if any). */
export async function resolveZenodoRecord(
  recordId: number,
  environment: ZenodoEnvironment,
): Promise<ResolvedZenodoRecord> {
  const record = await getZenodoRecord(recordId, environment);

  const token = await getStoredToken(environment);
  await throttle(environment);
  const { data: raw } = await zenodoClient.getRecord(recordId, token, environment);
  const conceptRecId: number | null = raw.conceptrecid ? parseInt(raw.conceptrecid, 10) : null;

  let versions: VersionInfo[] = [];
  if (conceptRecId !== null) {
    await throttle(environment);
    const { data: searchData } = await zenodoClient.searchRecords(
      { q: `conceptrecid:${conceptRecId}`, all_versions: "true", size: 50, sort: "version" },
      token,
      environment,
    );
    const hits: Record<string, any>[] = searchData.hits?.hits ?? [];
    versions = hits.map((h, i, arr) => ({
      recordId: h.id,
      doi: h.doi ?? null,
      version: h.metadata?.version ?? null,
      publicationDate: h.metadata?.publication_date ?? null,
      isLatest: i === arr.length - 1,
      isSelected: h.id === recordId,
    }));
  }

  return { record, versions, environment };
}
