import axios from "axios";
import { inferenceConfig } from "../config/env";
import { HttpError } from "../shared/http-error";

/**
 * The only code that talks to the Python inference service (MICD_TRAINING,
 * `POST /segmentation`). It sends one DICOM and returns the segmentation in the
 * contract the viewer already consumes. Transport outcomes become HttpErrors
 * with user-facing messages, so the service layer stays free of them:
 *   201 → the segmentation (validated field by field)
 *   400 → the service could not read the DICOM → 422
 *   422 → the model found no region → 422, with the service's message
 *   401 / 403 → the shared key doesn't match: a configuration error → 502
 *   timeout → 504; refused / DNS / 503 (model loading) → 503
 *   anything else, or an invalid body → 502
 */

export interface InferencePoint {
  x: number;
  y: number;
}

export interface InferenceResult {
  segmentationId: number | null;
  seed: number;
  model: string;
  /** Exact weights that answered (null for the mock), for traceability. */
  modelVersion: string | null;
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
  /** Frame to segment in a multi-frame image (0-based). Default 0. */
  frame?: number;
}

const unavailable = (): HttpError =>
  new HttpError(503, {
    error:
      "El servicio de inferencia no está disponible. Intentá de nuevo más tarde.",
  });

const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

const isNonNegInt = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) > 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

/**
 * Parse the service's body into the contract, or null if anything is off. The
 * mask is persisted as a clinical candidate, so its RLE must cover exactly
 * width×height pixels and agree with pixelCount. Only known fields are copied:
 * whatever else the service adds never reaches the client.
 */
export function parseInferenceResult(body: unknown): InferenceResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const { mask, derived } = b;

  if (
    !isNonNegInt(b.seed) ||
    !isStr(b.model) ||
    typeof b.simulated !== "boolean" ||
    !isNonNegInt(b.inferenceMs) ||
    !(b.modelVersion === undefined || isStrOrNull(b.modelVersion))
  ) {
    return null;
  }
  if (
    !Array.isArray(b.contour) ||
    !b.contour.every(
      (p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
    )
  ) {
    return null;
  }
  if (
    !mask ||
    !isPosInt(mask.width) ||
    !isPosInt(mask.height) ||
    !Array.isArray(mask.rle) ||
    !mask.rle.every(isNonNegInt) ||
    !isNonNegInt(mask.pixelCount)
  ) {
    return null;
  }
  const rle = mask.rle as number[];
  const covered = rle.reduce((sum, run) => sum + run, 0);
  const foreground = rle.reduce((sum, run, i) => (i % 2 ? sum + run : sum), 0);
  if (covered !== mask.width * mask.height || foreground !== mask.pixelCount) {
    return null;
  }
  if (
    !derived ||
    !isStr(derived.sopInstanceUid) ||
    !isStr(derived.seriesInstanceUid) ||
    !isStr(derived.seriesDescription) ||
    !isStrOrNull(derived.referencedSopInstanceUid) ||
    !isStrOrNull(derived.referencedSopClassUid) ||
    !isStr(derived.derivationDescription)
  ) {
    return null;
  }

  return {
    segmentationId: null,
    seed: b.seed,
    model: b.model,
    modelVersion: b.modelVersion ?? null,
    simulated: b.simulated,
    contour: b.contour.map((p: InferencePoint) => ({ x: p.x, y: p.y })),
    mask: {
      width: mask.width,
      height: mask.height,
      rle,
      pixelCount: mask.pixelCount,
    },
    derived: {
      sopInstanceUid: derived.sopInstanceUid,
      seriesInstanceUid: derived.seriesInstanceUid,
      seriesDescription: derived.seriesDescription,
      referencedSopInstanceUid: derived.referencedSopInstanceUid,
      referencedSopClassUid: derived.referencedSopClassUid,
      derivationDescription: derived.derivationDescription,
    },
    inferenceMs: b.inferenceMs,
  };
}

export async function segmentDicom(
  dicom: Buffer,
  options: InferenceOptions = {},
): Promise<InferenceResult> {
  const form = new FormData();
  // A view over the same memory, not a copy: the Blob makes the only copy.
  const bytes = new Uint8Array(
    dicom.buffer,
    dicom.byteOffset,
    dicom.byteLength,
  );
  form.append(
    "file",
    new Blob([bytes], { type: "application/dicom" }),
    "image.dcm",
  );
  if (options.seed !== undefined) form.append("seed", String(options.seed));
  if (options.points !== undefined) {
    form.append("points", String(options.points));
  }
  if (options.smoothingPasses !== undefined) {
    form.append("smoothing_passes", String(options.smoothingPasses));
  }
  if (options.frame !== undefined) form.append("frame", String(options.frame));

  let status: number;
  let data: unknown;
  try {
    const res = await axios.post(`${inferenceConfig.url}/segmentation`, form, {
      timeout: inferenceConfig.timeoutMs,
      validateStatus: () => true,
      headers: inferenceConfig.apiKey
        ? { "X-Inference-Key": inferenceConfig.apiKey }
        : undefined,
    });
    status = res.status;
    data = res.data;
  } catch (err) {
    // No HTTP answer at all: timeout, refused, DNS.
    const code = (err as { code?: string })?.code ?? "";
    console.error(
      `[inference] POST /segmentation failed: ${code || (err as Error)?.message}`,
    );
    if (TIMEOUT_CODES.has(code)) {
      throw new HttpError(504, {
        error: "El servicio de inferencia tardó demasiado en responder.",
      });
    }
    throw unavailable();
  }

  if (status === 201 || status === 200) {
    const result = parseInferenceResult(data);
    if (result) return result;
    console.error("[inference] invalid response body from /segmentation");
    throw new HttpError(502, {
      error: "El servicio de inferencia devolvió una respuesta inválida.",
    });
  }
  if (status === 400) {
    throw new HttpError(422, {
      error: "La imagen no es un DICOM que se pueda segmentar.",
    });
  }
  if (status === 422) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    throw new HttpError(422, {
      error:
        typeof detail === "string"
          ? detail
          : "El modelo no encontró ninguna región en la imagen.",
    });
  }
  console.error(
    `[inference] /segmentation answered ${status}: ${JSON.stringify(data)?.slice(0, 300)}`,
  );
  if (status === 503) throw unavailable();
  if (status === 401 || status === 403) {
    console.error(
      "[inference] the service rejected AI_INFERENCE_API_KEY — check that it matches INFERENCE_API_KEY",
    );
  }
  throw new HttpError(502, {
    error: `El servicio de inferencia respondió con un error (${status}).`,
  });
}

export interface SegResult {
  /** The DICOM SEG object bytes, ready to C-STORE to Orthanc. */
  dicom: Buffer;
  /** UIDs the service minted, echoed in response headers for persistence. */
  sopInstanceUid: string;
  seriesInstanceUid: string;
}

export interface BuildSegOptions {
  label?: string;
  seriesDescription?: string;
}

/**
 * Build a standard DICOM SEG from a stored mask + its source DICOM, via the
 * inference service (`POST /segmentation/seg`). Returns the SEG bytes plus the
 * minted UIDs (from `X-Seg-*` headers) so the caller can C-STORE it to Orthanc
 * and record the link. Transport outcomes map the same way as `segmentDicom`.
 */
export async function buildSeg(
  dicom: Buffer,
  maskRle: number[],
  options: BuildSegOptions = {},
): Promise<SegResult> {
  const form = new FormData();
  const bytes = new Uint8Array(
    dicom.buffer,
    dicom.byteOffset,
    dicom.byteLength,
  );
  form.append(
    "file",
    new Blob([bytes], { type: "application/dicom" }),
    "image.dcm",
  );
  form.append("mask_rle", JSON.stringify(maskRle));
  if (options.label) form.append("label", options.label);
  if (options.seriesDescription) {
    form.append("series_description", options.seriesDescription);
  }

  let status: number;
  let data: unknown;
  let headers: Record<string, string> = {};
  try {
    const res = await axios.post(
      `${inferenceConfig.url}/segmentation/seg`,
      form,
      {
        timeout: inferenceConfig.timeoutMs,
        responseType: "arraybuffer",
        validateStatus: () => true,
        headers: inferenceConfig.apiKey
          ? { "X-Inference-Key": inferenceConfig.apiKey }
          : undefined,
      },
    );
    status = res.status;
    data = res.data;
    headers = res.headers as Record<string, string>;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    console.error(
      `[inference] POST /segmentation/seg failed: ${code || (err as Error)?.message}`,
    );
    if (TIMEOUT_CODES.has(code)) {
      throw new HttpError(504, {
        error: "El servicio de inferencia tardó demasiado en responder.",
      });
    }
    throw unavailable();
  }

  if (status === 200) {
    const sopInstanceUid = headers["x-seg-sop-instance-uid"];
    const seriesInstanceUid = headers["x-seg-series-instance-uid"];
    if (!isStr(sopInstanceUid) || !isStr(seriesInstanceUid)) {
      console.error("[inference] /segmentation/seg missing X-Seg-* headers");
      throw new HttpError(502, {
        error: "El servicio de inferencia devolvió una respuesta inválida.",
      });
    }
    return {
      dicom: Buffer.from(data as ArrayBuffer),
      sopInstanceUid,
      seriesInstanceUid,
    };
  }

  // Error bodies come back as an ArrayBuffer of JSON under responseType.
  let detail: unknown;
  try {
    detail = JSON.parse(
      Buffer.from(data as ArrayBuffer).toString("utf8"),
    )?.detail;
  } catch {
    detail = undefined;
  }
  console.error(`[inference] /segmentation/seg answered ${status}`);
  if (status === 400 || status === 422) {
    throw new HttpError(422, {
      error:
        typeof detail === "string"
          ? detail
          : "No se pudo construir el DICOM SEG.",
    });
  }
  if (status === 503) throw unavailable();
  if (status === 401 || status === 403) {
    console.error(
      "[inference] the service rejected AI_INFERENCE_API_KEY — check that it matches INFERENCE_API_KEY",
    );
  }
  throw new HttpError(502, {
    error: `El servicio de inferencia respondió con un error (${status}).`,
  });
}
