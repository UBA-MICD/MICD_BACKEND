import { orthancClient } from "../../clients/orthanc.client";
import { HttpError } from "../../shared/http-error";
import { uploadConfig } from "../../config/env";
import * as repo from "./upload.repository";
import * as anonRepo from "./anonymization.repository";
import { anonymizeOne, anonymizeMany } from "./anonymization.service";
import { CRITICAL_TAGS } from "./anonymization.validator";

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
  /** Id of the anonymization job/log row for this upload. */
  jobId: string;
}

/**
 * Ingest a single DICOM file: anonymize it, validate the result, push it to
 * Orthanc, extract its tags, and upsert the metadata into Postgres. Throws
 * HttpError for every client-visible failure (400 invalid / 413 too large /
 * 422 anonymization failed / 409 duplicate / 503 Orthanc down / 500 DB write
 * failed).
 *
 * Anonymization happens BEFORE Orthanc and is fail-closed: if it fails or the
 * result still carries clear-text PHI, nothing is stored (US-16, AC1/AC3). A
 * row in `anonymization_jobs` records the per-study outcome (AC2).
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

  // Anonymize + validate before anything reaches Orthanc. The job row doubles
  // as the per-study anonymization log.
  const jobUuid = await anonRepo.createJob(1);
  const anon = await anonymizeOne("study.dcm", file.buffer);
  if (anon.status === "fallido" || !anon.buffer) {
    await anonRepo.markFailure(jobUuid, anon.error ?? "Anonimización fallida.");
    throw new HttpError(422, {
      error: "anonymization_failed",
      message:
        anon.error ??
        "No se pudo anonimizar el estudio; la carga fue rechazada y no se almacenó.",
      jobId: jobUuid,
    });
  }
  // Store the ANONYMIZED bytes (never the original). A 409 duplicate is a
  // legitimate "ask the user" outcome, not an anonymization failure, so it does
  // not mark the job failed.
  let stored: StoredInstance;
  try {
    stored = await storeAnonymizedInstance(anon.buffer, force);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 409)) {
      await anonRepo.markFailure(
        jobUuid,
        "No se pudo almacenar el estudio anonimizado.",
      );
    }
    throw err;
  }

  // Anonymized, validated and stored — close the log with the processed tags.
  await anonRepo.markSuccess(jobUuid, stored.studyId, CRITICAL_TAGS);

  return { study: stored.study, orthanc: stored.orthanc, jobId: jobUuid };
}

interface StoredInstance {
  study: any;
  orthanc: any;
  studyId: string;
}

/**
 * Push an already-anonymized DICOM to Orthanc, read back its tags and upsert
 * the study metadata. Shared by the single upload and the background batch
 * path. Callers MUST pass anonymized+validated bytes — this function does not
 * anonymize.
 */
async function storeAnonymizedInstance(
  anonymizedBuffer: Buffer,
  force: boolean,
): Promise<StoredInstance> {
  let orthancData: any;
  try {
    const { data } = await orthancClient.postInstance(anonymizedBuffer);
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

/**
 * Background processing of a multi-file (study) upload (US-16 large-study edge
 * case). The job row is already open in `procesando`; this anonymizes the whole
 * batch in one round-trip, stores every file that anonymizes+validates, and
 * closes the job. Fail-closed per file: anything that fails is never stored.
 * Errors are swallowed (logged to the job), since the HTTP response already
 * returned 202 — the caller polls the job for the outcome.
 */
export async function processBatchInBackground(
  jobUuid: string,
  files: { name: string; buffer: Buffer }[],
  force: boolean,
): Promise<void> {
  try {
    const results = await anonymizeMany(files);
    let stored = 0;
    let lastStudyId: string | null = null;
    const failures: string[] = [];

    for (const r of results) {
      if (r.status !== "exitoso" || !r.buffer) {
        failures.push(r.name);
        continue;
      }
      try {
        const s = await storeAnonymizedInstance(r.buffer, force);
        lastStudyId = s.studyId;
        stored++;
      } catch {
        // Duplicate or storage error for this file — count it as a failure but
        // keep going with the rest of the study.
        failures.push(r.name);
      }
    }

    if (stored === 0) {
      await anonRepo.markFailure(
        jobUuid,
        "Ningún archivo del estudio pudo anonimizarse y almacenarse.",
      );
      return;
    }

    await anonRepo.markSuccess(jobUuid, lastStudyId, CRITICAL_TAGS);
    if (failures.length > 0) {
      console.warn(
        `[upload] batch job ${jobUuid}: ${failures.length}/${files.length} files not stored`,
      );
    }
  } catch (err) {
    await anonRepo.markFailure(
      jobUuid,
      "Error inesperado procesando el estudio.",
    );
    console.error(`[upload] batch job ${jobUuid} failed`, err);
  }
}
