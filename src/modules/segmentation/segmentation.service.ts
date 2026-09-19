/**
 * segmentation.service.ts — AI segmentation (mocked SAM3).
 *
 * The whole point of this module is to be thrown away: it produces the exact
 * response shape a real SAM3 inference service would, so the browser client
 * never has to change when the model lands. See `runSegmentation` for the one
 * call site that has to be swapped.
 */

import { HttpError } from "../../shared/http-error";
import {
  generateSegmentationShape,
  type Point2D,
} from "./segmentation.geometry";

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
    throw new HttpError(400, { error: `El campo '${field}' debe ser numérico.` });
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

  return {
    seed,
    model: "mock-sam3",
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
