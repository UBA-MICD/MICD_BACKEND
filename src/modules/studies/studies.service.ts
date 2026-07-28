import { orthancClient } from "../../clients/orthanc.client";
import { HttpError, isHttpError } from "../../shared/http-error";
import {
  buildInstancesPayload,
  InstancesPayload,
} from "../../shared/instances-util";
import { zenodoClient } from "../../clients/zenodo.client";
import {
  getZenodoRecord,
  ZenodoRecordSummary,
} from "../zenodo/zenodo-search.service";
import { getStoredToken } from "../zenodo/zenodo.service";
import * as repo from "./studies.repository";
import { StudyFilters } from "./studies.repository";

const ORTHANC_UNAVAILABLE = (detail: string) =>
  new HttpError(503, { error: "Orthanc unavailable", detail });

// ── Legacy Orthanc proxy ──────────────────────────────────────────────────────

/** GET /api/studies — mirror Orthanc's study list. */
export async function listOrthancStudies(): Promise<unknown> {
  try {
    const { data } = await orthancClient.listStudies();
    return data;
  } catch (err: any) {
    throw ORTHANC_UNAVAILABLE(err.message);
  }
}

/** GET /api/studies/:id — mirror one Orthanc study. */
export async function getOrthancStudy(id: string): Promise<unknown> {
  try {
    const { data } = await orthancClient.getStudy(id);
    return data;
  } catch (err: any) {
    if (err.response?.status === 404) {
      throw new HttpError(404, { error: "Study not found" });
    }
    throw ORTHANC_UNAVAILABLE(err.message);
  }
}

/** DELETE /api/studies/:id — remove a study from Orthanc. */
export async function deleteOrthancStudy(id: string): Promise<void> {
  try {
    await orthancClient.deleteStudy(id);
  } catch (err: any) {
    if (err.response?.status === 404) {
      throw new HttpError(404, { error: "Study not found" });
    }
    throw ORTHANC_UNAVAILABLE(err.message);
  }
}

// ── v1 (Postgres-backed) ──────────────────────────────────────────────────────

/** The raw DICOM bytes of a study's first instance. */
export async function getStudyDicomFile(studyId: string): Promise<Buffer> {
  try {
    const instanceId = await repo.findFirstInstanceId(studyId);
    if (instanceId === null) {
      throw new HttpError(404, { error: "Study not found" });
    }
    const { data } = await orthancClient.getInstanceFile(instanceId);
    return Buffer.from(data);
  } catch (err: any) {
    if (isHttpError(err)) throw err;
    if (err.response?.status === 404) {
      throw new HttpError(404, { error: "Instance not found in Orthanc" });
    }
    throw ORTHANC_UNAVAILABLE(err.message);
  }
}

/** Ordered instance list for a study so the viewer can walk every image. */
export async function getStudyInstances(
  studyId: string,
): Promise<InstancesPayload> {
  try {
    const rows = await repo.findInstances(studyId);
    if (rows.length === 0) {
      throw new HttpError(404, { error: "Study not found" });
    }
    return buildInstancesPayload(studyId, rows);
  } catch (err: any) {
    if (isHttpError(err)) throw err;
    throw new HttpError(500, { error: err.message });
  }
}

/** The raw DICOM bytes of a specific instance within a study. */
export async function getInstanceDicomFile(
  studyId: string,
  instanceId: string,
): Promise<Buffer> {
  try {
    const exists = await repo.instanceExists(studyId, instanceId);
    if (!exists) {
      throw new HttpError(404, { error: "Instance not found" });
    }
    const { data } = await orthancClient.getInstanceFile(instanceId);
    return Buffer.from(data);
  } catch (err: any) {
    if (isHttpError(err)) throw err;
    if (err.response?.status === 404) {
      throw new HttpError(404, { error: "Instance not found in Orthanc" });
    }
    throw ORTHANC_UNAVAILABLE(err.message);
  }
}

export interface StudiesPage {
  studies: Record<string, any>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Paginated, filtered studies listing (one row per study). */
export async function listStudies(
  page: number,
  limit: number,
  filters: StudyFilters,
): Promise<StudiesPage> {
  try {
    const offset = (page - 1) * limit;
    const total = await repo.countStudies(filters);
    const studies = await repo.findStudies(filters, limit, offset);
    return { studies, total, page, limit, totalPages: Math.ceil(total / limit) };
  } catch (err: any) {
    if (isHttpError(err)) throw err;
    throw new HttpError(500, { error: err.message });
  }
}

export interface Thumbnail {
  buffer: Buffer;
  contentType: string;
}

/** A rendered preview image for a study's first instance. */
export async function getStudyThumbnail(studyId: string): Promise<Thumbnail> {
  try {
    const instanceId = await repo.findFirstInstanceId(studyId);
    if (instanceId === null) {
      throw new HttpError(404, { error: "Study not found" });
    }
    const { data, headers } =
      await orthancClient.getInstancePreview(instanceId);
    return {
      buffer: Buffer.from(data),
      contentType: (headers["content-type"] as string) ?? "image/jpeg",
    };
  } catch (err: any) {
    if (isHttpError(err)) throw err;
    if (err.response?.status === 404) {
      throw new HttpError(404, { error: "Instance not found in Orthanc" });
    }
    if (err.response?.status === 415 || err.response?.status === 400) {
      // Orthanc cannot render a preview for this DICOM type (e.g. RT-STRUCT, SR)
      throw new HttpError(422, {
        error: "Preview not available for this DICOM type",
      });
    }
    throw ORTHANC_UNAVAILABLE(err.message);
  }
}

// ── Zenodo detail ─────────────────────────────────────────────────────────────

export interface StudyZenodoDetail {
  doi: string;
  status: "published" | "imported" | "both";
  record: import("../zenodo/zenodo-search.service").ZenodoRecordDetail | null;
  versions: ZenodoRecordSummary[];
  stale: boolean;
  lastSyncedAt: string | null;
  downloads: number | null;
  newVersionAvailable: boolean;
  latestVersion: string | null;
}

function recordIdFromDoi(doi: string): number | null {
  // Zenodo DOIs: "10.5281/zenodo.{id}" — extract the trailing integer after the dot
  const match = doi.match(/\.(\d+)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return isNaN(n) ? null : n;
}

/** GET /api/v1/studies/:studyId/zenodo — live Zenodo metadata with local fallback. */
export async function getStudyZenodoDetail(
  studyId: string,
): Promise<StudyZenodoDetail> {
  const meta = await repo.findStudyZenodoMeta(studyId);
  if (!meta) throw new HttpError(404, { error: "Study not found" });

  const hasDoi = Boolean(meta.zenodo_doi);
  const hasSourceDoi = Boolean(meta.zenodo_source_doi);
  if (!hasDoi && !hasSourceDoi) {
    throw new HttpError(404, { error: "Study has no Zenodo association" });
  }

  const status: StudyZenodoDetail["status"] =
    hasDoi && hasSourceDoi ? "both" : hasDoi ? "published" : "imported";

  const doi = (meta.zenodo_doi ?? meta.zenodo_source_doi)!;
  const recordId = hasDoi
    ? recordIdFromDoi(meta.zenodo_doi!)
    : meta.zenodo_source_record_id;

  // 10.5072/* = sandbox, 10.5281/* = production
  const environment: "sandbox" | "production" = doi.startsWith("10.5072/")
    ? "sandbox"
    : "production";

  const lastSyncedAt = (
    meta.zenodo_published_at ?? meta.zenodo_imported_at
  )?.toISOString() ?? null;

  try {
    let liveRecord: import("../zenodo/zenodo-search.service").ZenodoRecordDetail | null = null;
    let versions: ZenodoRecordSummary[] = [];
    let downloads: number | null = null;
    let latestVersion: string | null = null;

    if (recordId !== null) {
      liveRecord = await getZenodoRecord(recordId, environment);

      const token = await getStoredToken(environment).catch(() => null);
      try {
        const { data } = await zenodoClient.getRecord(recordId, token, environment);
        downloads = data.stats?.downloads ?? null;
      } catch {
        // non-fatal
      }
    }

    if (meta.zenodo_concept_record_id !== null) {
      const token = await getStoredToken(environment).catch(() => null);
      try {
        const { data } = await zenodoClient.searchRecords(
          {
            q: `conceptrecid:${meta.zenodo_concept_record_id}`,
            all_versions: "true",
            size: 50,
            sort: "version",
          },
          token,
          environment,
        );
        const hits: Record<string, any>[] = data.hits?.hits ?? [];
        versions = hits.map((h: Record<string, any>) => {
          const m = h.metadata ?? {};
          return {
            id: h.id,
            doi: h.doi ?? null,
            title: m.title ?? "",
            authors: (m.creators ?? []).map((c: any) => ({ name: c.name ?? "" })),
            publicationDate: m.publication_date ?? null,
            license: m.license?.id ?? m.license ?? null,
            totalSize: (h.files ?? []).reduce((s: number, f: any) => s + (f.size ?? 0), 0),
            numFiles: (h.files ?? []).length,
            importable: false,
            url: h.links?.html ?? `https://zenodo.org/record/${h.id}`,
          } satisfies ZenodoRecordSummary;
        });
        const newest = versions[versions.length - 1];
        latestVersion = newest?.publicationDate ?? null;
      } catch {
        // non-fatal
      }
    }

    return {
      doi,
      status,
      record: liveRecord,
      versions,
      stale: false,
      lastSyncedAt,
      downloads,
      newVersionAvailable: meta.zenodo_new_version_available ?? false,
      latestVersion,
    };
  } catch (err: any) {
    if (isHttpError(err)) throw err;

    // Zenodo unreachable — return local data with stale flag
    return {
      doi,
      status,
      record: null,
      versions: [],
      stale: true,
      lastSyncedAt,
      downloads: null,
      newVersionAvailable: meta.zenodo_new_version_available ?? false,
      latestVersion: null,
    };
  }
}
