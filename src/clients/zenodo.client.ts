import axios, { AxiosResponse } from "axios";
import { zenodoTimeouts } from "../config/env";

/**
 * Thin wrapper around Zenodo's REST API (sandbox + production). Mirrors the
 * orthanc.client pattern: this is the only place the backend talks to Zenodo,
 * so URL construction and auth headers live here while the service layer owns
 * error mapping and business logic.
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

function bearer(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const zenodoClient = {
  /** Cheapest authenticated call there is — used to validate a token. */
  probeToken: (token: string, environment: ZenodoEnvironment): Promise<AxiosResponse> =>
    axios.get(`${API_BASE[environment]}/records`, {
      params: { size: 1, access_token: token },
      timeout: zenodoTimeouts.requestMs,
    }),

  // ── Records (search/detail, ZEN-06) ─────────────────────────────────────────
  searchRecords: (
    params: Record<string, string | number>,
    token: string | null,
    environment: ZenodoEnvironment,
  ): Promise<AxiosResponse> =>
    axios.get(`${API_BASE[environment]}/records`, {
      params,
      headers: bearer(token),
      timeout: zenodoTimeouts.requestMs,
    }),

  getRecord: (
    recordId: number,
    token: string | null,
    environment: ZenodoEnvironment,
  ): Promise<AxiosResponse> =>
    axios.get(`${API_BASE[environment]}/records/${recordId}`, {
      headers: bearer(token),
      timeout: zenodoTimeouts.requestMs,
    }),

  // ── Depositions (publish flow, ZEN-05) ──────────────────────────────────────
  createDeposition: (token: string, environment: ZenodoEnvironment): Promise<AxiosResponse> =>
    axios.post(
      `${API_BASE[environment]}/deposit/depositions`,
      {},
      {
        headers: { ...bearer(token), "Content-Type": "application/json" },
        timeout: zenodoTimeouts.requestMs,
      },
    ),

  setDepositionMetadata: (
    token: string,
    environment: ZenodoEnvironment,
    zenodoId: number,
    body: Record<string, unknown>,
  ): Promise<AxiosResponse> =>
    axios.put(`${API_BASE[environment]}/deposit/depositions/${zenodoId}`, body, {
      headers: { ...bearer(token), "Content-Type": "application/json" },
      timeout: zenodoTimeouts.requestMs,
    }),

  uploadFileToBucket: (
    token: string,
    bucketUrl: string,
    filename: string,
    data: Buffer,
  ): Promise<AxiosResponse> =>
    axios.put(`${bucketUrl}/${encodeURIComponent(filename)}`, data, {
      headers: { ...bearer(token), "Content-Type": "application/octet-stream" },
      maxBodyLength: Infinity,
      timeout: zenodoTimeouts.uploadMs,
    }),

  publishDeposition: (
    token: string,
    environment: ZenodoEnvironment,
    zenodoId: number,
  ): Promise<AxiosResponse> =>
    axios.post(
      `${API_BASE[environment]}/deposit/depositions/${zenodoId}/actions/publish`,
      {},
      { headers: bearer(token), timeout: zenodoTimeouts.requestMs },
    ),
};
