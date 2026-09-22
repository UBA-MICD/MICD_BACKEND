import { orthancClient } from "../../clients/orthanc.client";
import { HttpError } from "../../shared/http-error";
import { uploadConfig } from "../../config/env";
import * as repo from "./upload.repository";

// Same ceiling multer enforces while streaming (see upload.middleware.ts);
// re-checked here as defense in depth for callers that bypass the middleware.
const MAX_FILE_SIZE = uploadConfig.maxFileBytes;

// Tags use Latin-1 encoding in old DICOMs — normalize to UTF-8 safe string
function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return Buffer.from(value, "latin1").toString("utf8").trim();
  } catch {
    return value.trim();
  }
}

function extractTag(tags: Record<string, any>, tag: string): string {
  return normalizeText(tags[tag]?.Value ?? "");
}

function extractInt(tags: Record<string, any>, tag: string): number | null {
  const v = tags[tag]?.Value?.[0];
  return typeof v === "number" ? v : null;
}

export interface UploadResult {
  study: any;
  orthanc: any;
}

/**
 * Ingest a single DICOM file: push it to Orthanc, extract its tags, and upsert
 * the metadata into Postgres. Throws HttpError for every client-visible failure
 * (413 too large / 400 invalid / 409 duplicate / 503 Orthanc down / 500 DB
 * write failed).
 *
 * Anonymization is handled in the client before the bytes ever leave the
 * browser/desktop app (the web JS scrubber or, in the desktop build, the Python
 * anonymizer via PythonShell). The backend therefore stores what it receives
 * and no longer talks to an anonymization module.
 */
export async function uploadDicom(
  file: { buffer: Buffer; size: number },
  force: boolean,
): Promise<UploadResult> {
  // 413 — file too large
  if (file.size > MAX_FILE_SIZE) {
    throw new HttpError(413, {
      error: `File exceeds maximum allowed size of ${MAX_FILE_SIZE} bytes`,
    });
  }

  const stored = await storeInstance(file.buffer, force);
  return { study: stored.study, orthanc: stored.orthanc };
}

interface StoredInstance {
  study: any;
  orthanc: any;
  studyId: string;
}

/**
 * Push a DICOM to Orthanc, read back its tags and upsert the study metadata.
 */
async function storeInstance(
  buffer: Buffer,
  force: boolean,
): Promise<StoredInstance> {
  let orthancData: any;
  try {
    const { data } = await orthancClient.postInstance(buffer);
    orthancData = data;
  } catch (err: any) {
    console.error(
      `[upload] Orthanc error — status=${err.response?.status} message=${err.message} data=${JSON.stringify(err.response?.data)}`,
    );
    if (err.response?.status === 400) {
      throw new HttpError(400, { error: "Invalid DICOM file" });
    }
    throw new HttpError(503, {
      error: "Orthanc unavailable",
      detail: err.message,
    });
  }

  const instanceId: string = orthancData.ID;
  const studyId: string = orthancData.ParentStudy;
  const isAlreadyStored: boolean = orthancData.Status === "AlreadyStored";
  console.log(
    `[upload] Orthanc response — status=${orthancData.Status} instanceId=${instanceId} studyId=${studyId} isAlreadyStored=${isAlreadyStored}`,
  );

  // Fetch DICOM tags from Orthanc
  let tags: Record<string, any> = {};
  try {
    const { data } = await orthancClient.getInstanceTags(instanceId);
    tags = data;
  } catch {
    // non-fatal: proceed without tags
  }

  const sopInstanceUid = extractTag(tags, "0008,0018");
  const studyInstanceUid = extractTag(tags, "0020,000d");
  const patientName = extractTag(tags, "0010,0010");
  const patientId = extractTag(tags, "0010,0020");
  const studyDate = extractTag(tags, "0008,0020");
  const studyDesc = extractTag(tags, "0008,1030");
  const rawModality = extractTag(tags, "0008,0060").toUpperCase();
  const modality = rawModality || "OTHER";
  const instanceNumber = extractInt(tags, "0020,0013");
  const rows = extractInt(tags, "0028,0010");
  const cols = extractInt(tags, "0028,0011");
  const seriesDescription = extractTag(tags, "0008,103e"); // Series Description
  const numberOfImages = extractInt(tags, "0020,1208"); // Number of Study Related Images

  console.log(`[upload] tags — sopUid=${sopInstanceUid} modality=${modality}`);

  // Duplicate detected — ask the user before overwriting
  if (isAlreadyStored) {
    const existing = await repo.findBySopInstanceUid(sopInstanceUid);
    console.log(
      `[upload] duplicate detected — existing in DB=${!!existing} force=${force}`,
    );

    if (!force) {
      throw new HttpError(409, {
        error: "duplicate",
        message:
          "A study with this ID already exists. Do you want to replace it?",
        sopInstanceUid,
        existingStudyId: existing?.orthanc_study_id ?? studyId,
      });
    }

    // force=true: delete existing record and re-insert
    await repo.deleteBySopInstanceUid(sopInstanceUid);
  }

  // Persist metadata in PostgreSQL
  let study: any;
  try {
    study = await repo.upsertStudy({
      orthancStudyId: studyId,
      orthancInstanceId: instanceId,
      sopInstanceUid,
      studyInstanceUid,
      patientName,
      patientId,
      studyDate,
      modality,
      studyDescription: studyDesc,
      seriesDescription,
      numberOfImages,
      instanceNumber,
      rows,
      cols,
    });
  } catch (err: any) {
    throw new HttpError(500, {
      error: "Failed to save study metadata to database",
      detail: err.message,
    });
  }

  return { study, orthanc: orthancData, studyId };
}
