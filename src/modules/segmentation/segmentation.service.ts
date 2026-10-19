/**
 * segmentation.service.ts — AI segmentation (US-41 / TK-44).
 *
 * The segmentation itself runs in the Python inference service (MICD_TRAINING).
 * This module fetches the source DICOM from Orthanc, forwards it, persists the
 * returned candidate so it can be corrected (US-45), and hands the viewer the
 * response unchanged — the contract is the one the service already returns.
 */

import axios from "axios";
import { HttpError, isHttpError } from "../../shared/http-error";
import { logAction, AUDIT_ACTIONS, type AuditAction } from "../../shared/audit";
import { inferenceConfig } from "../../config/env";
import { orthancClient } from "../../clients/orthanc.client";
import {
  segmentDicom,
  type InferenceResult,
} from "../../clients/inference.client";
import * as repo from "./segmentation.repository";

export type {
  SegmentationRecord,
  CorrectionRecord,
  SegmentationStatus,
  Rle,
  MaskShape,
} from "./segmentation.repository";

// ── Contract ─────────────────────────────────────────────────────────────────

export interface SegmentationRequest {
  /**
   * Source instance. Required: the image is fetched from Orthanc by this UID,
   * so a DICOM opened off the local disk (not on the server) can't be segmented.
   * Any studyInstanceUid the client sends is ignored — the study is taken from
   * the stored instance.
   */
  sopInstanceUid?: unknown;
  /** Optional seed (0..2^32-1), forwarded for reproducibility. */
  seed?: unknown;
  /** Polar vertices before smoothing (16-512, default 96). */
  points?: unknown;
  /** Chaikin smoothing passes (0-4, default 2). */
  smoothingPasses?: unknown;
  /**
   * Frame to segment in a multi-frame image (0-based, default 0). The inference
   * service validates it against the DICOM's NumberOfFrames.
   */
  frame?: unknown;
}

/**
 * What the viewer receives: the inference service's response, with
 * `segmentationId` set to the persisted candidate's id.
 */
export type SegmentationResponse = InferenceResult;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** DICOM UID: dot-separated digits, at most 64 characters. */
const DICOM_UID = /^[0-9]+(\.[0-9]+)*$/;

function requireUid(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    throw new HttpError(422, {
      error:
        "La segmentación con IA requiere una imagen del servidor; las abiertas desde el disco local no se pueden segmentar.",
    });
  }
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !DICOM_UID.test(value)
  ) {
    throw new HttpError(400, {
      error: "El campo 'sopInstanceUid' no es un UID DICOM válido.",
    });
  }
  return value;
}

function optionalSeed(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new HttpError(400, {
      error: "El campo 'seed' debe ser un entero entre 0 y 4294967295.",
    });
  }
  return n;
}

function optionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, {
      error: `El campo '${field}' debe ser numérico.`,
    });
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 0-based frame index. The upper bound (NumberOfFrames) is enforced by the
 * inference service, which reads it from the DICOM. */
function optionalFrame(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, {
      error: "El campo 'frame' debe ser un entero mayor o igual a 0.",
    });
  }
  return n;
}

const notOnServer = (): HttpError =>
  new HttpError(404, { error: "La imagen no está en el servidor." });

/** The stored DICOM for an instance, or a 404 when the server doesn't have it. */
async function fetchSourceDicom(orthancInstanceId: string): Promise<Buffer> {
  try {
    const res = await orthancClient.getInstanceFile(orthancInstanceId);
    // Buffer.from(ArrayBuffer) is a view, not a copy.
    return Buffer.from(res.data);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      throw notOnServer();
    }
    throw new HttpError(503, { error: "Orthanc no está disponible." });
  }
}

/**
 * Segmentations currently running. Each one holds a whole DICOM in memory and
 * an inference call open, so past the cap a request is turned away (429)
 * instead of queuing more work behind a busy model.
 */
let inFlight = 0;

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Segment one image stored on the server.
 *
 * Keep this signature stable: the browser calls it through
 * `POST /api/v1/ml/segmentation`. Rows/Columns are no longer needed from the
 * client — the inference service reads them from the DICOM itself. Every
 * attempt that reaches the stored image is audited (TK-06), success or not.
 */
export async function runSegmentation(
  input: SegmentationRequest,
  context: { userId: number; ip: string },
): Promise<SegmentationResponse> {
  const sopInstanceUid = requireUid(input.sopInstanceUid);
  const seed = optionalSeed(input.seed);
  const points = optionalInt(input.points, "points", 16, 512);
  const smoothingPasses = optionalInt(
    input.smoothingPasses,
    "smoothingPasses",
    0,
    4,
  );
  const frame = optionalFrame(input.frame);

  if (inFlight >= inferenceConfig.maxConcurrency) {
    throw new HttpError(429, {
      error:
        "Hay demasiadas segmentaciones en curso. Intentá de nuevo en unos segundos.",
    });
  }
  inFlight++;

  const audit = (
    action: AuditAction,
    detail: Record<string, unknown>,
  ): void => {
    void logAction({
      userId: context.userId,
      action,
      resourceId: sopInstanceUid,
      ip: context.ip,
      detail,
    });
  };

  try {
    const stored = await repo.findStoredInstance(sopInstanceUid);
    if (!stored) throw notOnServer();

    const dicom = await fetchSourceDicom(stored.orthancInstanceId);
    const result = await segmentDicom(dicom, {
      seed,
      points,
      smoothingPasses,
      frame,
    });

    // Persist the candidate so it can be corrected later (US-45).
    const record = await repo.insertSegmentation({
      studyId: stored.studyInstanceUid,
      instanceId: sopInstanceUid,
      modelId: result.model,
      modelVersion: result.modelVersion,
      prompt: { seed: result.seed, points, smoothingPasses, frame },
      maskRle: result.mask.rle,
      maskShape: [result.mask.height, result.mask.width],
      status: "candidate",
      createdBy: context.userId,
    });

    audit(AUDIT_ACTIONS.AI_SEGMENTATION_REQUESTED, {
      segmentationId: record.id,
      model: result.model,
      simulated: result.simulated,
    });
    return { ...result, segmentationId: record.id };
  } catch (err) {
    audit(AUDIT_ACTIONS.AI_SEGMENTATION_FAILED, {
      status: isHttpError(err) ? err.status : 500,
    });
    throw err;
  } finally {
    inFlight--;
  }
}

// ── Corrections (US-45) ───────────────────────────────────────────────────────

export interface CorrectionResponse {
  correctionId: number;
  segmentationId: number;
  correctedBy: string;
  correctedAt: string;
  editSummary: Record<string, unknown> | null;
}

export interface SegmentationHistoryResponse {
  segmentation: {
    segmentationId: number;
    status: repo.SegmentationStatus;
    model: string | null;
    maskRle: repo.Rle | null;
    maskShape: repo.MaskShape | null;
    createdBy: string;
    createdAt: string;
    reviewedBy: string | null;
    reviewedAt: string | null;
  };
  corrections: CorrectionResponse[];
}

function toCorrectionResponse(
  record: repo.CorrectionRecord,
): CorrectionResponse {
  return {
    correctionId: record.id,
    segmentationId: record.segmentationId,
    correctedBy: record.createdByEmail,
    correctedAt: record.createdAt.toISOString(),
    editSummary: record.editSummary,
  };
}

async function requireSegmentation(
  segmentationId: number,
): Promise<repo.SegmentationRecord> {
  const record = await repo.findSegmentationById(segmentationId);
  if (!record) {
    throw new HttpError(404, { error: "Segmentación no encontrada." });
  }
  return record;
}

/**
 * Save a human correction over an AI candidate. Append-only: a new row chained
 * (via `corrects_id`) to the latest correction, so the original candidate and
 * every prior correction are preserved for clinical traceability. Stamps the
 * candidate as `corrected` and records who/when on it.
 */
export async function saveCorrection(params: {
  segmentationId: number;
  correctedRle: repo.Rle;
  maskShape: repo.MaskShape;
  editSummary?: Record<string, unknown> | null;
  userId: number;
  ip: string;
}): Promise<CorrectionResponse> {
  const segmentation = await requireSegmentation(params.segmentationId);
  if (segmentation.status === "discarded") {
    throw new HttpError(409, {
      error: "La segmentación fue descartada; no admite correcciones.",
    });
  }
  if (!Array.isArray(params.correctedRle) || params.correctedRle.length === 0) {
    throw new HttpError(400, {
      error: "El campo 'correctedRle' debe ser un RLE no vacío.",
    });
  }
  if (
    !Array.isArray(params.maskShape) ||
    params.maskShape.length !== 2 ||
    !params.maskShape.every((n) => Number.isInteger(n) && n > 0)
  ) {
    throw new HttpError(400, {
      error:
        "El campo 'maskShape' debe ser [height, width] de enteros positivos.",
    });
  }

  try {
    const chain = await repo.listCorrections(params.segmentationId);
    const correctsId = chain[0]?.id ?? null; // newest first ⇒ link to head

    const record = await repo.insertCorrection({
      segmentationId: params.segmentationId,
      studyId: segmentation.studyId,
      instanceId: segmentation.instanceId,
      correctedRle: params.correctedRle,
      maskShape: params.maskShape,
      editSummary: params.editSummary ?? null,
      correctsId,
      createdBy: params.userId,
    });

    await repo.updateSegmentationStatus(
      params.segmentationId,
      "corrected",
      params.userId,
    );

    void logAction({
      userId: params.userId,
      action: AUDIT_ACTIONS.AI_SEGMENTATION_CORRECTED,
      resourceId: String(params.segmentationId),
      ip: params.ip,
      detail: { correctionId: record.id, correctsId },
    });

    return toCorrectionResponse(record);
  } catch (err) {
    if (isHttpError(err)) throw err;
    throw new HttpError(500, { error: (err as Error).message });
  }
}

/** Approve the candidate as-is (no edits). */
export async function acceptSegmentation(params: {
  segmentationId: number;
  userId: number;
  ip: string;
}): Promise<SegmentationHistoryResponse> {
  await requireSegmentation(params.segmentationId);
  await repo.updateSegmentationStatus(
    params.segmentationId,
    "accepted",
    params.userId,
  );
  void logAction({
    userId: params.userId,
    action: AUDIT_ACTIONS.AI_SEGMENTATION_REVIEWED,
    resourceId: String(params.segmentationId),
    ip: params.ip,
    detail: { status: "accepted" },
  });
  return getHistory(params.segmentationId);
}

/** Discard the whole segmentation (reject it). */
export async function discardSegmentation(params: {
  segmentationId: number;
  userId: number;
  ip: string;
}): Promise<SegmentationHistoryResponse> {
  await requireSegmentation(params.segmentationId);
  await repo.updateSegmentationStatus(
    params.segmentationId,
    "discarded",
    params.userId,
  );
  void logAction({
    userId: params.userId,
    action: AUDIT_ACTIONS.AI_SEGMENTATION_REVIEWED,
    resourceId: String(params.segmentationId),
    ip: params.ip,
    detail: { status: "discarded" },
  });
  return getHistory(params.segmentationId);
}

/** The candidate plus its full correction chain (newest first). */
export async function getHistory(
  segmentationId: number,
): Promise<SegmentationHistoryResponse> {
  const segmentation = await requireSegmentation(segmentationId);
  const corrections = await repo.listCorrections(segmentationId);
  return {
    segmentation: {
      segmentationId: segmentation.id,
      status: segmentation.status,
      model: segmentation.modelId,
      maskRle: segmentation.maskRle,
      maskShape: segmentation.maskShape,
      createdBy: segmentation.createdByEmail,
      createdAt: segmentation.createdAt.toISOString(),
      reviewedBy: segmentation.reviewedByEmail,
      reviewedAt: segmentation.reviewedAt
        ? segmentation.reviewedAt.toISOString()
        : null,
    },
    corrections: corrections.map(toCorrectionResponse),
  };
}

export interface SegmentationByIdResponse {
  segmentationId: number;
  status: repo.SegmentationStatus;
  model: string | null;
  modelVersion: string | null;
  maskRle: repo.Rle | null;
  maskShape: repo.MaskShape | null;
  createdBy: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/** One persisted candidate by its id (DB read), or 404. The correction chain
 * is served separately by {@link getHistory} (`/:id/corrections`). */
export async function getSegmentationById(
  segmentationId: number,
): Promise<SegmentationByIdResponse> {
  const s = await requireSegmentation(segmentationId);
  return {
    segmentationId: s.id,
    status: s.status,
    model: s.modelId,
    modelVersion: s.modelVersion,
    maskRle: s.maskRle,
    maskShape: s.maskShape,
    createdBy: s.createdByEmail,
    createdAt: s.createdAt.toISOString(),
    reviewedBy: s.reviewedByEmail,
    reviewedAt: s.reviewedAt ? s.reviewedAt.toISOString() : null,
  };
}

// ── Reload on open (bug 3): fetch the current segmentation for an image ────────

export interface InstanceSegmentationResponse {
  segmentationId: number;
  status: repo.SegmentationStatus;
  /** Candidate (original AI) mask. */
  maskRle: repo.Rle | null;
  maskShape: repo.MaskShape | null;
  /** Latest human correction, if any — the client prefers this over the original. */
  correctedRle: repo.Rle | null;
  correctedMaskShape: repo.MaskShape | null;
  correctedBy: string | null;
  correctedAt: string | null;
}

/**
 * The current segmentation for one image (study + instance), or null. Returns
 * both the original candidate mask and the latest correction mask so the viewer
 * can redraw the polygon after a slice/layout change or a page reload — the
 * corrected version when it exists, otherwise the original.
 */
export async function getLatestForInstance(
  studyId: string,
  instanceId: string,
): Promise<InstanceSegmentationResponse | null> {
  const seg = await repo.findLatestSegmentation(studyId, instanceId);
  if (!seg || seg.status === "discarded") return null;
  const corrections = await repo.listCorrections(seg.id); // newest first
  const latest = corrections[0] ?? null;
  return {
    segmentationId: seg.id,
    status: seg.status,
    maskRle: seg.maskRle,
    maskShape: seg.maskShape,
    correctedRle: latest ? latest.correctedRle : null,
    correctedMaskShape: latest ? latest.maskShape : null,
    correctedBy: latest ? latest.createdByEmail : null,
    correctedAt: latest ? latest.createdAt.toISOString() : null,
  };
}
