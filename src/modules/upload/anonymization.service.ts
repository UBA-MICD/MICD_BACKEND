import {
  anonymizerClient,
  AnonymizerContractError,
  AnonymizerRejectedError,
  AnonymizerUnavailableError,
} from "../../clients/anonymizer.client";
import { anonymizerConfig } from "../../config/env";
import { HttpError } from "../../shared/http-error";
import { validateAnonymized } from "./anonymization.validator";

/**
 * Anonymization orchestration (US-16). Sits between the upload flow and the
 * external module: it anonymizes (single or bulk), then independently validates
 * that the four critical tags are gone before letting anything be stored. It is
 * strictly fail-closed — every error, timeout, contract break or failed
 * validation resolves to a `fallido` file with a non-PHI reason, never to a
 * buffer the caller might upload.
 *
 * The functions here are DB-free and client-injectable, so they unit-test with
 * the anonymizer client mocked; the job lifecycle (Postgres) lives in
 * anonymization.repository.ts and is covered by the integration suite.
 */

export interface AnonymizedFile {
  name: string;
  status: "exitoso" | "fallido";
  /** Anonymized, validated bytes — present ONLY when status is "exitoso". */
  buffer?: Buffer;
  /** Human, PHI-free reason when status is "fallido". */
  error?: string;
}

/** Map a client error to a user-facing, PHI-free message. */
function humanize(err: unknown): string {
  if (err instanceof AnonymizerRejectedError) {
    return err.message || "El archivo no es un DICOM válido.";
  }
  if (err instanceof AnonymizerContractError) {
    return "El módulo de anonimización cambió su interfaz; la carga fue rechazada.";
  }
  if (err instanceof AnonymizerUnavailableError) {
    return "El servicio de anonimización no está disponible.";
  }
  return "Error inesperado durante la anonimización.";
}

/** Validate an anonymized buffer against its original; never throws. */
function validateFile(
  name: string,
  original: Buffer,
  anonymized: Buffer,
): AnonymizedFile {
  try {
    const { ok, leaked, marked } = validateAnonymized(anonymized, original);
    if (ok) return { name, status: "exitoso", buffer: anonymized };
    const reason = leaked.length
      ? `Tags sin anonimizar: ${leaked.join(", ")}`
      : !marked
        ? "El resultado no quedó marcado como anonimizado (PatientIdentityRemoved)."
        : "La validación de anonimización falló.";
    return { name, status: "fallido", error: reason };
  } catch {
    // Unparseable result → treat as not-anonymized. Fail closed.
    return {
      name,
      status: "fallido",
      error: "No se pudo validar el DICOM anonimizado.",
    };
  }
}

/** Anonymize + validate a single DICOM. */
export async function anonymizeOne(
  name: string,
  buffer: Buffer,
): Promise<AnonymizedFile> {
  let anonymized: Buffer;
  try {
    anonymized = await anonymizerClient.anonymize(buffer);
  } catch (err) {
    return { name, status: "fallido", error: humanize(err) };
  }
  return validateFile(name, buffer, anonymized);
}

/** Anonymize + validate several DICOMs in one round-trip (studies). */
export async function anonymizeMany(
  files: { name: string; buffer: Buffer }[],
): Promise<AnonymizedFile[]> {
  let result: {
    anonymized: Map<string, Buffer>;
    errores: Record<string, string>;
  };
  try {
    result = await anonymizerClient.anonymizeBulk(files);
  } catch (err) {
    // Whole batch could not be processed (module down / all invalid).
    const message = humanize(err);
    return files.map((f) => ({
      name: f.name,
      status: "fallido",
      error: message,
    }));
  }

  return files.map((f) => {
    const rejected = result.errores[f.name];
    if (rejected) return { name: f.name, status: "fallido", error: rejected };
    const anonymized = result.anonymized.get(f.name);
    if (!anonymized) {
      return {
        name: f.name,
        status: "fallido",
        error: "El módulo no devolvió el archivo anonimizado.",
      };
    }
    return validateFile(f.name, f.buffer, anonymized);
  });
}

/**
 * Fail-closed preflight: reject the upload immediately with a clear message if
 * the anonymizer is disabled or unreachable, so no DICOM is ever accepted while
 * it cannot be anonymized (US-16, AC3).
 */
export async function ensureAnonymizerAvailable(): Promise<void> {
  if (!anonymizerConfig.enabled) {
    throw new HttpError(503, {
      error: "anonymizer_disabled",
      message:
        "La anonimización está deshabilitada; la carga fue rechazada y el estudio no se almacenó.",
    });
  }
  const healthy = await anonymizerClient.health();
  if (!healthy) {
    throw new HttpError(503, {
      error: "anonymizer_unavailable",
      message:
        "El servicio de anonimización no está disponible; la carga fue rechazada y el estudio no se almacenó.",
    });
  }
}
