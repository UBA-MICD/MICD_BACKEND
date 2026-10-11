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
import { logAction, AUDIT_ACTIONS } from "../../shared/audit";
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
   */
  sopInstanceUid?: string;
  studyInstanceUid?: string;
  /** Optional seed, forwarded for reproducibility. */
  seed?: number;
  /** Polar vertices before smoothing (16-512, default 96). */
  points?: number;
  /** Chaikin smoothing passes (0-4, default 2). */
  smoothingPasses?: number;
}

/**
 * What the viewer receives: the inference service's response, with
 * `segmentationId` set to the persisted candidate's id.
 */
export type SegmentationResponse = InferenceResult;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** The stored DICOM for an instance, or a 404 when the server doesn't have it. */
async function fetchSourceDicom(sopInstanceUid: string): Promise<Buffer> {
  const orthancId = await repo.findOrthancInstanceId(sopInstanceUid);
  if (!orthancId) {
    throw new HttpError(404, {
      error: "La imagen no está en el servidor.",
    });
  }
  try {
    const res = await orthancClient.getInstanceFile(orthancId);
    return Buffer.from(res.data);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      throw new HttpError(404, {
        error: "La imagen no está en el servidor.",
      });
    }
    throw new HttpError(503, { error: "Orthanc no está disponible." });
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Segment one image stored on the server.
 *
 * Keep this signature stable: the browser calls it through
 * `POST /api/v1/ml/segmentation`. Rows/Columns are no longer needed from the
 * client — the inference service reads them from the DICOM itself.
 */
export async function runSegmentation(
  input: SegmentationRequest,
  context?: { userId?: number },
): Promise<SegmentationResponse> {
  if (!input.sopInstanceUid) {
    throw new HttpError(422, {
      error:
        "La segmentación con IA requiere una imagen del servidor; las abiertas desde el disco local no se pueden segmentar.",
    });
  }
  const points = optionalInt(input.points, "points", 16, 512);
  const smoothingPasses = optionalInt(
    input.smoothingPasses,
    "smoothingPasses",
    0,
    4,
  );
  const seed =
    input.seed !== undefined && Number.isFinite(Number(input.seed))
      ? Number(input.seed) >>> 0
      : undefined;

  const dicom = await fetchSourceDicom(input.sopInstanceUid);
  const result = await segmentDicom(dicom, { seed, points, smoothingPasses });

  // Persist the candidate so it can be corrected later (US-45).
  let segmentationId: number | null = null;
  if (context?.userId) {
    const record = await repo.insertSegmentation({
      studyId: input.studyInstanceUid ?? null,
      instanceId: input.sopInstanceUid,
      modelId: result.model,
      modelVersion: null,
      prompt: { seed: result.seed, points, smoothingPasses },
      maskRle: result.mask.rle,
      maskShape: [result.mask.height, result.mask.width],
      status: "candidate",
      createdBy: context.userId,
    });
    segmentationId = record.id;
  }

  return { ...result, segmentationId };
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
