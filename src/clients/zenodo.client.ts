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
};
