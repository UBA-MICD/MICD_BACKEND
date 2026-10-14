/**
 * segmentation.service.ts — AI segmentation (mocked SAM3).
 *
 * The whole point of this module is to be thrown away: it produces the exact
 * response shape a real SAM3 inference service would, so the browser client
 * never has to change when the model lands. See `runSegmentation` for the one
 * call site that has to be swapped.
 */

import { HttpError, isHttpError } from "../../shared/http-error";
import { logAction, AUDIT_ACTIONS } from "../../shared/audit";
import {
  generateSegmentationShape,
  type Point2D,
} from "./segmentation.geometry";
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
  /** DICOM Columns (0028,0011) of the source image. */
  columns: number;
  /** DICOM Rows (0028,0010) of the source image. */
  rows: number;
  /** Optional seed. Omitted ⇒ a fresh random shape on every call. */
  seed?: number;
  /** Source instance, echoed back as the derived image's reference. */
  sopInstanceUid?: string;
  sopClassUid?: string;
  studyInstanceUid?: string;
  /** Polar vertices before smoothing (16-512, default 96). */
  points?: number;
  /** Chaikin smoothing passes (0-4, default 2). */
  smoothingPasses?: number;
}

export interface SegmentationResponse {
  /**
   * DB id of the persisted candidate, or null when nothing was persisted
   * (image opened off local disk with no source UID). The client needs this id
   * to submit corrections against the candidate (US-45).
   */
  segmentationId: number | null;
  /** Echoed so the client can reproduce the exact same shape. */
  seed: number;
  /** Model identifier. `mock-sam3` tells the UI to show the "Simulado" badge. */
  model: string;
  simulated: boolean;
  /** Closed outline in image pixel coordinates, in draw order. */
  contour: Point2D[];
  mask: {
    width: number;
    height: number;
    /** Alternating run lengths, row-major, starting with a run of zeros. */
    rle: number[];
    pixelCount: number;
  };
  /** Metadata for the derived DICOM the client builds from the original. */
  derived: {
    sopInstanceUid: string;
    seriesInstanceUid: string;
    seriesDescription: string;
    /** ReferencedImageSequence (0008,1140) > ReferencedSOPInstanceUID. */
    referencedSopInstanceUid: string | null;
    referencedSopClassUid: string | null;
    /** DerivationDescription (0008,2111). */
    derivationDescription: string;
  };
  /** Milliseconds the (simulated) inference took. */
  inferenceMs: number;
}

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Series description required for the derived series. */
export const DERIVED_SERIES_DESCRIPTION = "Segmentación IA (mock SAM3)";

/**
 * Simulated inference latency window. Wide enough that the client's spinner is
 * exercised the way a real GPU round-trip would exercise it.
 */
const MIN_LATENCY_MS = 1500;
const MAX_LATENCY_MS = 2500;

/**
 * UID root for everything this mock mints. `.999` is a deliberately fake
 * branch: a real deployment must register its own root before any derived
 * instance is written back to the PACS.
 */
const MOCK_UID_ROOT = "1.2.826.0.1.3680043.10.1338.999";

const MAX_IMAGE_SIDE = 8192;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mint a DICOM UID under the mock root. DICOM caps UIDs at 64 characters and
 * forbids leading zeros in a component, so each suffix component is a plain
 * positive integer.
 */
export function mintUid(root: string = MOCK_UID_ROOT): string {
  const timePart = Date.now();
  const randomPart = Math.floor(Math.random() * 1_000_000_000);
  const uid = `${root}.${timePart}.${randomPart}`;
  return uid.length <= 64 ? uid : uid.slice(0, 64).replace(/\.$/, "");
}

function requireSide(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, {
      error: `El campo '${field}' debe ser un entero positivo.`,
    });
  }
  if (n > MAX_IMAGE_SIDE) {
    throw new HttpError(400, {
      error: `El campo '${field}' excede el máximo admitido (${MAX_IMAGE_SIDE}).`,
    });
  }
  return n;
}

function optionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, {
      error: `El campo '${field}' debe ser numérico.`,
    });
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Produce a segmentation for one image.
 *
 * Keep this signature stable: the browser calls it through
 * `POST /api/v1/ml/segmentation` and does not know, or care, whether the mask
 * came from a model or from the generator below.
 */
export async function runSegmentation(
  input: SegmentationRequest,
  context?: { userId?: number },
): Promise<SegmentationResponse> {
  const columns = requireSide(input.columns, "columns");
  const rows = requireSide(input.rows, "rows");
  const points = optionalInt(input.points, "points", 16, 512, 96);
  const smoothingPasses = optionalInt(
    input.smoothingPasses,
    "smoothingPasses",
    0,
    4,
    2,
  );

  // A caller-supplied seed makes the result reproducible; without one every
  // press of the button yields a different shape, which is what the UI wants.
  const seed =
    input.seed !== undefined && Number.isFinite(Number(input.seed))
      ? Number(input.seed) >>> 0
      : (Math.random() * 0xffffffff) >>> 0;

  const startedAt = Date.now();

  // MOCK: reemplazar por llamada a SAM3 ────────────────────────────────────
  // Replace the sleep + generator below with the real inference call, e.g.:
  //   const { contour, maskRle, pixelCount } = await sam3Client.segment({
  //     pixelData, rows, columns, prompt,
  //   });
  // Everything after this block (UID minting, response assembly) stays as is.
  const latency =
    MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS);
  await sleep(latency);
  const shape = generateSegmentationShape({
    columns,
    rows,
    seed,
    points,
    smoothingPasses,
  });
  // ─────────────────────────────────────────────────────────────────────────

  const model = "mock-sam3";

  // Persist the candidate so it can be corrected later (US-45). We can only do
  // this when the image has a source instance UID to anchor it to — viewer
  // sessions on local-disk DICOM have none, and stay in-memory as before.
  let segmentationId: number | null = null;
  if (input.sopInstanceUid && context?.userId) {
    const record = await repo.insertSegmentation({
      studyId: input.studyInstanceUid ?? null,
      instanceId: input.sopInstanceUid,
      modelId: model,
      modelVersion: null,
      prompt: { seed, points, smoothingPasses },
      maskRle: shape.maskRle,
      maskShape: [rows, columns],
      status: "candidate",
      createdBy: context.userId,
    });
    segmentationId = record.id;
  }

  return {
    segmentationId,
    seed,
    model,
    simulated: true,
    contour: shape.contour.map((p) => ({
      // Two decimals is well under a pixel and keeps the payload small.
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
    })),
    mask: {
      width: columns,
      height: rows,
      rle: shape.maskRle,
      pixelCount: shape.pixelCount,
    },
    derived: {
      sopInstanceUid: mintUid(),
      seriesInstanceUid: mintUid(),
      seriesDescription: DERIVED_SERIES_DESCRIPTION,
      referencedSopInstanceUid: input.sopInstanceUid || null,
      referencedSopClassUid: input.sopClassUid || null,
      derivationDescription: "Segmentación automática simulada (mock SAM3)",
    },
    inferenceMs: Date.now() - startedAt,
  };
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
