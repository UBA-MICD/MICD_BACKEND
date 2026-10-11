import axios from "axios";
import { inferenceConfig } from "../config/env";
import { HttpError } from "../shared/http-error";

/**
 * The only code that talks to the Python inference service (MICD_TRAINING,
 * `POST /segmentation`). It sends one DICOM and returns the segmentation in the
 * contract the viewer already consumes. Transport outcomes become HttpErrors
 * with user-facing messages, so the service layer stays free of them:
 *   201 → the segmentation
 *   400 → the service could not read the DICOM → 422
 *   timeout / connection refused → 503, service unavailable
 *   anything else → 502, the service answered but not usefully
 */

export interface InferencePoint {
  x: number;
  y: number;
}

export interface InferenceResult {
  segmentationId: number | null;
  seed: number;
  model: string;
  simulated: boolean;
  contour: InferencePoint[];
  mask: { width: number; height: number; rle: number[]; pixelCount: number };
  derived: {
    sopInstanceUid: string;
    seriesInstanceUid: string;
    seriesDescription: string;
    referencedSopInstanceUid: string | null;
    referencedSopClassUid: string | null;
    derivationDescription: string;
  };
  inferenceMs: number;
}

export interface InferenceOptions {
  seed?: number;
  points?: number;
  smoothingPasses?: number;
}

const unavailable = (): HttpError =>
  new HttpError(503, {
    error:
      "El servicio de inferencia no está disponible. Intentá de nuevo más tarde.",
  });

function isInferenceResult(body: unknown): body is InferenceResult {
  const b = body as InferenceResult | null;
  return (
    !!b &&
    typeof b.model === "string" &&
    Array.isArray(b.contour) &&
    !!b.mask &&
    Array.isArray(b.mask.rle) &&
    Number.isInteger(b.mask.width) &&
    Number.isInteger(b.mask.height) &&
    !!b.derived
  );
}

export async function segmentDicom(
  dicom: Buffer,
  options: InferenceOptions = {},
): Promise<InferenceResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(dicom)], { type: "application/dicom" }),
    "image.dcm",
  );
  if (options.seed !== undefined) form.append("seed", String(options.seed));
  if (options.points !== undefined)
    form.append("points", String(options.points));
  if (options.smoothingPasses !== undefined) {
    form.append("smoothing_passes", String(options.smoothingPasses));
  }

  let status: number;
  let data: unknown;
  try {
    const res = await axios.post(`${inferenceConfig.url}/segmentation`, form, {
      timeout: inferenceConfig.timeoutMs,
      validateStatus: () => true,
    });
    status = res.status;
    data = res.data;
  } catch {
    // No HTTP answer at all: refused, DNS, or the timeout above.
    throw unavailable();
  }

  if (status === 201 || status === 200) {
    if (isInferenceResult(data)) return data;
    throw new HttpError(502, {
      error: "El servicio de inferencia devolvió una respuesta inválida.",
    });
  }
  if (status === 400) {
    throw new HttpError(422, {
      error: "La imagen no es un DICOM que se pueda segmentar.",
    });
  }
  if (status === 503) throw unavailable();
  throw new HttpError(502, {
    error: `El servicio de inferencia respondió con un error (${status}).`,
  });
}
