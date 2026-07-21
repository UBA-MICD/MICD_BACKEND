import { orthancClient } from "../../clients/orthanc.client";
import { HttpError, isHttpError } from "../../shared/http-error";
import {
  buildInstancesPayload,
  InstancesPayload,
} from "../../shared/instances-util";
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
