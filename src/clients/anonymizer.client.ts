import axios, { AxiosError } from "axios";
import FormData from "form-data";
import * as unzipper from "unzipper";
import { anonymizerConfig } from "../config/env";

/**
 * Thin wrapper around the electronics team's DICOM anonymizer (US-16).
 *
 * Mirrors the orthanc.client / zenodo.client pattern: this is the ONLY place
 * the backend talks to the anonymizer, so URL construction and transport live
 * here while the service layer (anonymization.service.ts) owns the fail-closed
 * policy and error → HTTP mapping. The module is a FastAPI service reached over
 * HTTP on the shared Docker network; the backend never imports its Python.
 *
 * Contract (verified against the module's own tests/server/ suite):
 *   GET  /                — { "health": "Instance is up" }
 *   POST /anonymize/      — multipart file + profile (required) → application/dicom
 *   POST /bulk_anonymize/ — multipart files[] + profile (required) → application/zip
 *                           (one .dcm per input; invalid ones listed in errores.json;
 *                            all-invalid → 400 { detail: { name: reason } })
 * A missing `profile` yields 422 on either endpoint — the contract tests pin this.
 *
 * NOTE: never log DICOM bytes or parsed tag values from here — they are PHI
 * until the anonymizer has run and the service has validated the result.
 */

/** The module is down, timed out, or returned an unexpected status. */
export class AnonymizerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnonymizerUnavailableError";
  }
}

/** The module rejected the input as not a valid DICOM (HTTP 400). */
export class AnonymizerRejectedError extends Error {
  constructor(
    message: string,
    /** Per-file reasons for the bulk endpoint; undefined for the single one. */
    public readonly detail?: Record<string, string>,
  ) {
    super(message);
    this.name = "AnonymizerRejectedError";
  }
}

/** The module's interface changed out from under us (e.g. profile now optional/renamed). */
export class AnonymizerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnonymizerContractError";
  }
}

const DICOM_CONTENT_TYPE = "application/dicom";

/** Parse an arraybuffer error body (axios keeps it as bytes for responseType:"arraybuffer"). */
function parseErrorBody(data: unknown): unknown {
  try {
    const text = Buffer.from(data as ArrayBuffer).toString("utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const anonymizerClient = {
  /** Liveness probe used by health checks and the upload preflight. */
  async health(): Promise<boolean> {
    try {
      const { status, data } = await axios.get(`${anonymizerConfig.url}/`, {
        timeout: 3000,
      });
      return status === 200 && typeof data?.health === "string";
    } catch {
      return false;
    }
  },

  /** Anonymize a single DICOM. Returns the anonymized bytes. */
  async anonymize(buffer: Buffer): Promise<Buffer> {
    const form = new FormData();
    form.append("file", buffer, {
      filename: "study.dcm",
      contentType: DICOM_CONTENT_TYPE,
    });
    form.append("profile", anonymizerConfig.profile);

    try {
      const { data } = await axios.post(
        `${anonymizerConfig.url}/anonymize/`,
        form,
        {
          headers: form.getHeaders(),
          responseType: "arraybuffer",
          timeout: anonymizerConfig.timeoutMs,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        },
      );
      return Buffer.from(data);
    } catch (err) {
      throw mapError(err, "El archivo no es un DICOM válido.");
    }
  },

  /**
   * Anonymize several DICOMs in one round-trip (studies / multi-file uploads).
   * Returns the anonymized bytes keyed by filename plus a per-file `errores`
   * map for inputs the module could not process (fail-closed: the caller must
   * NOT store anything listed in `errores`).
   */
  async anonymizeBulk(
    files: { name: string; buffer: Buffer }[],
  ): Promise<{
    anonymized: Map<string, Buffer>;
    errores: Record<string, string>;
  }> {
    const form = new FormData();
    for (const f of files) {
      form.append("files", f.buffer, {
        filename: f.name,
        contentType: DICOM_CONTENT_TYPE,
      });
    }
    form.append("profile", anonymizerConfig.profile);

    let zipBuffer: Buffer;
    try {
      const { data } = await axios.post(
        `${anonymizerConfig.url}/bulk_anonymize/`,
        form,
        {
          headers: form.getHeaders(),
          responseType: "arraybuffer",
          timeout: anonymizerConfig.timeoutMs,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        },
      );
      zipBuffer = Buffer.from(data);
    } catch (err) {
      const axErr = err as AxiosError;
      // All inputs invalid → 400 with a per-file detail map.
      if (axErr.response?.status === 400) {
        const body = parseErrorBody(axErr.response.data) as
          { detail?: Record<string, string> } | undefined;
        throw new AnonymizerRejectedError(
          "Ningún archivo pudo anonimizarse.",
          body?.detail,
        );
      }
      throw mapError(err, "Ningún archivo pudo anonimizarse.");
    }

    const directory = await unzipper.Open.buffer(zipBuffer);
    const anonymized = new Map<string, Buffer>();
    let errores: Record<string, string> = {};
    for (const entry of directory.files) {
      const content = await entry.buffer();
      if (entry.path === "errores.json") {
        errores = JSON.parse(content.toString("utf8")) as Record<
          string,
          string
        >;
      } else {
        anonymized.set(entry.path, content);
      }
    }
    return { anonymized, errores };
  },
};

/** Common axios-error → typed-error mapping for the anonymize endpoints. */
function mapError(err: unknown, rejectMessage: string): Error {
  const axErr = err as AxiosError;
  const status = axErr.response?.status;
  if (status === 400) {
    return new AnonymizerRejectedError(rejectMessage);
  }
  if (status === 422) {
    // The endpoint validation failed — for us this means the multipart
    // contract (required `profile`/`file` fields) no longer matches.
    return new AnonymizerContractError(
      "El módulo de anonimización rechazó la petición (422): el contrato de la interfaz cambió.",
    );
  }
  return new AnonymizerUnavailableError(
    axErr.message ?? "Anonymizer unavailable",
  );
}
