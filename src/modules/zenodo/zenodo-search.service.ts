import { zenodoClient } from "../../clients/zenodo.client";
import { type ZenodoEnvironment, getStoredToken } from "./zenodo.service";
import { throttle } from "./zenodo-rate-limit.service";

const IMPORTABLE_EXTENSIONS = [".dcm", ".zip"];

export interface SearchFilters {
  q: string;
  page?: number;
  size?: number;
  fileType?: string;
  license?: string;
  dateFrom?: string;
  dateTo?: string;
  keywords?: string;
}

export interface ZenodoAuthorResult {
  name: string;
  affiliation?: string;
}

export interface ZenodoFileResult {
  key: string;
  size: number;
  checksum?: string;
}

export interface ZenodoRecordSummary {
  id: number;
  doi: string | null;
  title: string;
  authors: ZenodoAuthorResult[];
  publicationDate: string | null;
  license: string | null;
  totalSize: number;
  numFiles: number;
  importable: boolean;
  url: string;
}

export interface ZenodoRecordDetail extends ZenodoRecordSummary {
  description: string | null;
  keywords: string[];
  files: ZenodoFileResult[];
}

export interface SearchResult {
  records: ZenodoRecordSummary[];
  total: number;
  page: number;
  size: number;
}

function isImportable(files: ZenodoFileResult[]): boolean {
  return files.some((f) =>
    IMPORTABLE_EXTENSIONS.some((ext) => f.key.toLowerCase().endsWith(ext)),
  );
}

function parseRecord(raw: Record<string, any>): {
  summary: ZenodoRecordSummary;
  files: ZenodoFileResult[];
  description: string | null;
  keywords: string[];
} {
  const meta = raw.metadata ?? {};
  const files: ZenodoFileResult[] = (raw.files ?? []).map((f: any) => ({
    key: f.key ?? f.filename ?? "",
    size: f.size ?? 0,
    checksum: f.checksum,
  }));

  const totalSize = files.reduce((acc, f) => acc + f.size, 0);

  return {
    summary: {
      id: raw.id,
      doi: raw.doi ?? null,
      title: meta.title ?? "(sin título)",
      authors: (meta.creators ?? []).map((c: any) => ({
        name: c.name ?? "",
        ...(c.affiliation ? { affiliation: c.affiliation } : {}),
      })),
      publicationDate: meta.publication_date ?? null,
      license: meta.license?.id ?? meta.license ?? null,
      totalSize,
      numFiles: files.length,
      importable: isImportable(files),
      url: raw.links?.html ?? `https://zenodo.org/record/${raw.id}`,
    },
    files,
    description: meta.description ?? null,
    keywords: meta.keywords ?? [],
  };
}

function buildQuery(filters: SearchFilters): string {
  let q = filters.q.trim();

  if (filters.fileType) {
    const ext = filters.fileType.replace(/^\./, "");
    q = `${q} file_type:${ext}`.trim();
  }
  if (filters.keywords) {
    q = `${q} ${filters.keywords}`.trim();
  }
  if (filters.dateFrom) {
    q = `${q} publication_date:[${filters.dateFrom} TO ${filters.dateTo ?? "*"}]`;
  }

  return q;
}

export async function searchZenodo(
  filters: SearchFilters,
  environment: ZenodoEnvironment = "production",
): Promise<SearchResult> {
  const page = filters.page ?? 1;
  const size = Math.min(filters.size ?? 20, 100);

  const token = await getStoredToken(environment);

  const params: Record<string, string | number> = {
    q: buildQuery(filters),
    type: "dataset",
    page,
    size,
  };
  if (filters.license) params["license"] = filters.license;

  await throttle(environment);
  const { data } = await zenodoClient.searchRecords(params, token, environment);

  const hits: Record<string, any>[] = data.hits?.hits ?? [];
  const total: number = data.hits?.total ?? 0;

  return {
    records: hits.map((h) => parseRecord(h).summary),
    total,
    page,
    size,
  };
}

export async function getZenodoRecord(
  recordId: number,
  environment: ZenodoEnvironment = "production",
): Promise<ZenodoRecordDetail> {
  const token = await getStoredToken(environment);

  await throttle(environment);
  const { data } = await zenodoClient.getRecord(recordId, token, environment);

  const { summary, files, description, keywords } = parseRecord(data);

  return { ...summary, files, description, keywords };
}
