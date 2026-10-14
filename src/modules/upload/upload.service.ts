import { orthancClient } from "../../clients/orthanc.client";
import { HttpError } from "../../shared/http-error";
import { anonymizationConfig, uploadConfig } from "../../config/env";
import {
  describeFindings,
  verifyInstanceTags,
  type PhiFinding,
} from "../../shared/phi-verification";
import * as repo from "./upload.repository";
import { pathologyExists } from "../pathologies/pathologies.service";

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
  studyId: string;
  /** PHI-free summary of the pre-storage check, surfaced to the user (TK-11). */
  verification: {
    needsReview: boolean;
    findings: PhiFinding[];
  };
}

/**
 * Ingest a single DICOM file: push it to Orthanc, extract its tags, and upsert
 * the metadata into Postgres. Throws HttpError for every client-visible failure
 * (413 too large / 400 invalid / 409 duplicate / 422 not anonymized / 503
 * Orthanc down / 500 DB write failed).
 *
 * Anonymization is handled on the client, before the bytes ever leave the
 * user's machine, so this stores what it receives rather than anonymizing.
 * It does, however, *verify* what it received, without trusting it (TK-11): the
 * tags Orthanc reads back are checked, and `studies.anonymized_at` is set only
 * when they carry no identifying value.
 *
 * What a failed check does depends on ANONYMIZATION_VERIFY_MODE: in `strict`
 * the instance is deleted from Orthanc and nothing is stored (the caller gets a
 * 422 listing the offending tags); in `warn` it is stored but flagged
 * `needs_review`. Either way the verifier is the gate, not the client.
 */
export async function uploadDicom(
  file: { buffer: Buffer; size: number },
  force: boolean,
  classificationId: number | null = null,
): Promise<UploadResult> {
  // 413 — file too large
  if (file.size > MAX_FILE_SIZE) {
    throw new HttpError(413, {
      error: `File exceeds maximum allowed size of ${MAX_FILE_SIZE} bytes`,
    });
  }

  // Reject an unknown category up front, before touching Orthanc. Free text is
  // impossible — classification_id is an integer validated against the catalog.
  if (classificationId !== null && !(await pathologyExists(classificationId))) {
    throw new HttpError(400, { error: "Unknown classification_id" });
  }

  const stored = await storeInstance(file.buffer, force, classificationId);
  return {
    study: stored.study,
    orthanc: stored.orthanc,
    studyId: stored.studyId,
    verification: stored.verification,
  };
}

interface StoredInstance {
  study: any;
  orthanc: any;
  studyId: string;
  verification: { needsReview: boolean; findings: PhiFinding[] };
}

/**
 * Push a DICOM to Orthanc, read back its tags and upsert the study metadata.
 */
async function storeInstance(
  buffer: Buffer,
  force: boolean,
  classificationId: number | null,
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

  // Verify rather than trust: this is what may later set anonymized_at.
  const verification = verifyInstanceTags(tags);
  console.log(
    `[upload] tags — sopUid=${sopInstanceUid} modality=${modality} anonymized=${verification.clean}` +
      (verification.clean
        ? ""
        : ` unverified=[${describeFindings(verification.findings)}]`),
  );

  // TK-11 — the check gates storage. A residual-PII (error) finding means the
  // instance carries identifying data; in strict mode it must not be kept, so
  // delete it from Orthanc (which drops the now-empty parents too) and refuse
  // with the offending tag list — names and reasons only, never values.
  const mode = anonymizationConfig.verifyMode;
  if (!verification.clean && mode === "strict") {
    try {
      await orthancClient.deleteInstance(instanceId);
    } catch (err: any) {
      // Best-effort cleanup; still refuse the upload.
      console.error(
        `[upload] could not delete rejected instance ${instanceId}: ${err.message}`,
      );
    }
    throw new HttpError(422, {
      error: "not_anonymized",
      message:
        "El estudio conserva datos identificatorios y no fue almacenado.",
      tags: verification.findings.map((f) => ({
        tag: f.tag,
        name: f.name,
        reason: f.reason,
        severity: f.severity,
      })),
    });
  }

  // Not blocked (warn mode, or only warnings): record WHY for a human. In warn
  // mode that includes the error findings we are letting through; in strict it
  // is just the warnings. PhiFinding is PHI-free by construction.
  const reviewFindings: PhiFinding[] = verification.findings.filter(
    (f) => mode === "warn" || f.severity === "warning",
  );
  const needsReview = reviewFindings.length > 0;

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
      anonymizedAt: verification.clean ? new Date() : null,
      classificationId,
      needsReview,
      reviewFindings: needsReview ? reviewFindings : undefined,
    });
  } catch (err: any) {
    throw new HttpError(500, {
      error: "Failed to save study metadata to database",
      detail: err.message,
    });
  }

  return {
    study,
    orthanc: orthancData,
    studyId,
    verification: { needsReview, findings: reviewFindings },
  };
}
