import axios, { AxiosError, AxiosResponse } from "axios";
import { zenodoTimeouts } from "../config/env";

/**
 * Thin wrapper around Zenodo's REST API (sandbox + production). Mirrors the
 * orthanc.client pattern: this is the only place the backend talks to Zenodo,
 * so URL construction, auth headers, and resilience (ZEN-15) live here while
 * the service layer owns error mapping and business logic.
 *
 * NOTE: never log raw axios errors from these calls — axios embeds the token
 * in the request URL/config, and logging it would leak the token.
 */
export const ZENODO_ENVIRONMENTS = ["sandbox", "production"] as const;
export type ZenodoEnvironment = (typeof ZENODO_ENVIRONMENTS)[number];

const API_BASE: Record<ZenodoEnvironment, string> = {
  sandbox: "https://sandbox.zenodo.org/api",
  production: "https://zenodo.org/api",
};

export class ZenodoNotConfiguredError extends Error {
  constructor(environment: ZenodoEnvironment) {
    super(`No hay un token de Zenodo configurado para el entorno "${environment}"`);
    this.name = "ZenodoNotConfiguredError";
  }
}

function bearer(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Auth-required methods rely on this instead of each caller re-checking for a token. */
function requireToken(token: string | null, environment: ZenodoEnvironment): string {
  if (!token) throw new ZenodoNotConfiguredError(environment);
  return token;
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const DEFAULT_RETRY_AFTER_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(err: AxiosError): number {
  const header = err.response?.headers?.["retry-after"];
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(String(header)) - Date.now();
  return dateMs > 0 ? dateMs : DEFAULT_RETRY_AFTER_MS;
}

/**
 * Retries a Zenodo request per ZEN-15: 429 waits for the server-specified
 * Retry-After header, 5xx backs off exponentially (1s/2s/4s) — both capped at
 * MAX_RETRIES so a persistently unhealthy Zenodo still surfaces to the caller.
 * Anything else (4xx, network errors) is not retryable and rethrows immediately.
 */
async function withResilience<T>(fn: () => Promise<AxiosResponse<T>>): Promise<AxiosResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr?.response?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      await sleep(status === 429 ? retryAfterMs(axiosErr) : BACKOFF_MS[attempt]);
    }
  }
}

export const zenodoClient = {
  /** Cheapest authenticated call there is — used to validate a token. */
  probeToken: (token: string, environment: ZenodoEnvironment): Promise<AxiosResponse> =>
    withResilience(() =>
      axios.get(`${API_BASE[environment]}/records`, {
        params: { size: 1, access_token: token },
        timeout: zenodoTimeouts.requestMs,
      }),
    ),

  // ── Records (search/detail, ZEN-06) ─────────────────────────────────────────
  searchRecords: (
    params: Record<string, string | number>,
    token: string | null,
    environment: ZenodoEnvironment,
  ): Promise<AxiosResponse> =>
    withResilience(() =>
      axios.get(`${API_BASE[environment]}/records`, {
        params,
        headers: bearer(token),
        timeout: zenodoTimeouts.requestMs,
      }),
    ),

  getRecord: (
    recordId: number,
    token: string | null,
    environment: ZenodoEnvironment,
  ): Promise<AxiosResponse> =>
    withResilience(() =>
      axios.get(`${API_BASE[environment]}/records/${recordId}`, {
        headers: bearer(token),
        timeout: zenodoTimeouts.requestMs,
      }),
    ),

  /** Download one file of a record as a stream (ZEN-07 import). */
  downloadRecordFileStream: (
    recordId: number,
    fileKey: string,
    token: string | null,
    environment: ZenodoEnvironment,
  ): Promise<AxiosResponse> =>
    withResilience(() =>
      axios.get(
        `${API_BASE[environment]}/records/${recordId}/files/${encodeURIComponent(fileKey)}/content`,
        {
          responseType: "stream",
          headers: bearer(token),
          timeout: zenodoTimeouts.uploadMs,
        },
      ),
    ),

  // ── Depositions (publish flow, ZEN-05) ──────────────────────────────────────
  createDeposition: async (
    token: string | null,
    environment: ZenodoEnvironment,
  ): Promise<AxiosResponse> => {
    const authToken = requireToken(token, environment);
    return withResilience(() =>
      axios.post(
        `${API_BASE[environment]}/deposit/depositions`,
        {},
        {
          headers: { ...bearer(authToken), "Content-Type": "application/json" },
          timeout: zenodoTimeouts.requestMs,
        },
      ),
    );
  },

  setDepositionMetadata: async (
    token: string | null,
    environment: ZenodoEnvironment,
    zenodoId: number,
    body: Record<string, unknown>,
  ): Promise<AxiosResponse> => {
    const authToken = requireToken(token, environment);
    return withResilience(() =>
      axios.put(`${API_BASE[environment]}/deposit/depositions/${zenodoId}`, body, {
        headers: { ...bearer(authToken), "Content-Type": "application/json" },
        timeout: zenodoTimeouts.requestMs,
      }),
    );
  },

  uploadFileToBucket: async (
    token: string | null,
    bucketUrl: string,
    filename: string,
    data: Buffer,
    environment: ZenodoEnvironment,
  ): Promise<AxiosResponse> => {
    const authToken = requireToken(token, environment);
    return withResilience(() =>
      axios.put(`${bucketUrl}/${encodeURIComponent(filename)}`, data, {
        headers: { ...bearer(authToken), "Content-Type": "application/octet-stream" },
        maxBodyLength: Infinity,
        timeout: zenodoTimeouts.uploadMs,
      }),
    );
  },

  publishDeposition: async (
    token: string | null,
    environment: ZenodoEnvironment,
    zenodoId: number,
  ): Promise<AxiosResponse> => {
    const authToken = requireToken(token, environment);
    return withResilience(() =>
      axios.post(
        `${API_BASE[environment]}/deposit/depositions/${zenodoId}/actions/publish`,
        {},
        { headers: bearer(authToken), timeout: zenodoTimeouts.requestMs },
      ),
    );
  },

  /** Lists the files already uploaded to a (draft or published) deposition. */
  listFiles: async (
    token: string | null,
    environment: ZenodoEnvironment,
    zenodoId: number,
  ): Promise<AxiosResponse> => {
    const authToken = requireToken(token, environment);
    return withResilience(() =>
      axios.get(`${API_BASE[environment]}/deposit/depositions/${zenodoId}/files`, {
        headers: bearer(authToken),
        timeout: zenodoTimeouts.requestMs,
      }),
    );
  },

  /** Creates a new draft version of a published deposition. */
  newVersion: async (
    token: string | null,
    environment: ZenodoEnvironment,
    zenodoId: number,
  ): Promise<AxiosResponse> => {
    const authToken = requireToken(token, environment);
    return withResilience(() =>
      axios.post(
        `${API_BASE[environment]}/deposit/depositions/${zenodoId}/actions/newversion`,
        {},
        { headers: bearer(authToken), timeout: zenodoTimeouts.requestMs },
      ),
    );
  },
};
