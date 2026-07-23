import { pool } from "../../db/pool";
import {
  zenodoClient,
  ZENODO_ENVIRONMENTS,
  type ZenodoEnvironment,
} from "../../clients/zenodo.client";
import { decrypt, encrypt } from "../../shared/encryption";
import { AUDIT_ACTIONS, logActionWithClient } from "../../shared/audit";

// Re-exported so the rest of the module imports environment types from the
// service, keeping the client an internal detail.
export { ZENODO_ENVIRONMENTS };
export type { ZenodoEnvironment };

export type ValidateTokenResult =
  | { valid: true }
  | {
      valid: false;
      reason: "invalid_token" | "insufficient_permissions" | "timeout" | "unknown_error";
    };

// NOTE: never log the raw error here — axios embeds the token in the request
// URL/config, and logging it would leak the token to the server logs.
export async function validateToken(
  token: string,
  environment: ZenodoEnvironment,
): Promise<ValidateTokenResult> {
  try {
    await zenodoClient.probeToken(token, environment);
    return { valid: true };
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e?.code === "ECONNABORTED" || e?.code === "ETIMEDOUT") {
      return { valid: false, reason: "timeout" };
    }
    const status = (e?.response as Record<string, unknown>)?.status;
    if (status === 401) return { valid: false, reason: "invalid_token" };
    if (status === 403) return { valid: false, reason: "insufficient_permissions" };
    return { valid: false, reason: "unknown_error" };
  }
}

export async function getStoredToken(environment: ZenodoEnvironment): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT token_encrypted FROM zenodo_config WHERE environment = $1",
    [environment],
  );
  if (rows.length === 0) return null;
  return decrypt(rows[0].token_encrypted);
}

export type ZenodoHealthStatus = "connected" | "error" | "unconfigured";

export interface ZenodoHealthRow {
  environment: ZenodoEnvironment;
  status: ZenodoHealthStatus;
  error_reason: string | null;
  last_checked: Date;
  last_success: Date | null;
}

export async function checkHealth(environment: ZenodoEnvironment): Promise<ZenodoHealthRow> {
  const token = await getStoredToken(environment);

  if (token === null) {
    const { rows } = await pool.query<ZenodoHealthRow>(
      `INSERT INTO zenodo_health (environment, status, error_reason, last_checked, last_success)
       VALUES ($1, 'unconfigured', NULL, NOW(), NULL)
       ON CONFLICT (environment) DO UPDATE SET
         status       = 'unconfigured',
         error_reason = NULL,
         last_checked = NOW(),
         last_success = NULL
       RETURNING *`,
      [environment],
    );
    return rows[0];
  }

  const result = await validateToken(token, environment);

  if (result.valid) {
    const { rows } = await pool.query<ZenodoHealthRow>(
      `INSERT INTO zenodo_health (environment, status, error_reason, last_checked, last_success)
       VALUES ($1, 'connected', NULL, NOW(), NOW())
       ON CONFLICT (environment) DO UPDATE SET
         status       = 'connected',
         error_reason = NULL,
         last_checked = NOW(),
         last_success = NOW()
       RETURNING *`,
      [environment],
    );
    return rows[0];
  }

  // On error: preserve last_success from previous row if it exists
  const { rows } = await pool.query<ZenodoHealthRow>(
    `INSERT INTO zenodo_health (environment, status, error_reason, last_checked, last_success)
     VALUES ($1, 'error', $2, NOW(), NULL)
     ON CONFLICT (environment) DO UPDATE SET
       status       = 'error',
       error_reason = $2,
       last_checked = NOW()
     RETURNING *`,
    [environment, result.reason],
  );
  return rows[0];
}

export async function checkAllEnvironments(): Promise<void> {
  await Promise.all((["sandbox", "production"] as ZenodoEnvironment[]).map(checkHealth));
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface HealthEnvironmentStatus {
  status: ZenodoHealthStatus;
  last_checked: Date | null;
  last_success: Date | null;
  error_reason: string | null;
  token_expiry_warning: boolean;
  token_expires_at: Date | null;
}

/** Panel-state view: last health-check result + token-expiry warning per env. */
export async function getHealthStatus(): Promise<
  Record<ZenodoEnvironment, HealthEnvironmentStatus>
> {
  const { rows: healthRows } = await pool.query<ZenodoHealthRow>(
    "SELECT environment, status, error_reason, last_checked, last_success FROM zenodo_health",
  );
  const { rows: configRows } = await pool.query<{
    environment: ZenodoEnvironment;
    token_expires_at: Date | null;
  }>("SELECT environment, token_expires_at FROM zenodo_config");

  const healthByEnv = new Map(healthRows.map((r) => [r.environment, r]));
  const configByEnv = new Map(configRows.map((r) => [r.environment, r]));

  const build = (env: ZenodoEnvironment): HealthEnvironmentStatus => {
    const health = healthByEnv.get(env);
    const config = configByEnv.get(env);
    const tokenExpiresAt = config?.token_expires_at ?? null;
    const tokenExpiryWarning =
      tokenExpiresAt !== null &&
      new Date(tokenExpiresAt).getTime() - Date.now() < THIRTY_DAYS_MS;

    if (!health) {
      return {
        status: "unconfigured" as const,
        last_checked: null,
        last_success: null,
        error_reason: null,
        token_expiry_warning: tokenExpiryWarning,
        token_expires_at: tokenExpiresAt,
      };
    }

    return {
      status: health.status,
      last_checked: health.last_checked,
      last_success: health.last_success,
      error_reason: health.error_reason,
      token_expiry_warning: tokenExpiryWarning,
      token_expires_at: tokenExpiresAt,
    };
  };

  return { sandbox: build("sandbox"), production: build("production") };
}

function maskToken(token: string): string {
  return token.length <= 4 ? "xxxx" : `xxxx...${token.slice(-4)}`;
}

export class ZenodoTokenError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "ZenodoTokenError";
  }
}

export async function configureZenodoToken(
  token: string,
  environment: ZenodoEnvironment,
  userId: number,
  ip: string,
): Promise<{ hint: string }> {
  const result = await validateToken(token, environment);
  if (!result.valid) {
    throw new ZenodoTokenError("Token inválido", result.reason);
  }

  const encrypted = encrypt(token);
  const hint = maskToken(token);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO zenodo_config (environment, token_encrypted, token_hint, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW())
       ON CONFLICT (environment) DO UPDATE SET
         token_encrypted = EXCLUDED.token_encrypted,
         token_hint      = EXCLUDED.token_hint,
         created_by      = EXCLUDED.created_by,
         updated_at      = NOW()`,
      [environment, encrypted, hint, userId],
    );
    await logActionWithClient(client, {
      userId,
      action: AUDIT_ACTIONS.ZENODO_TOKEN_CONFIGURED,
      resourceId: environment,
      ip,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { hint };
}

export async function removeZenodoConfig(
  environment: ZenodoEnvironment,
  userId: number,
  ip: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM zenodo_config WHERE environment = $1", [environment]);
    await logActionWithClient(client, {
      userId,
      action: AUDIT_ACTIONS.ZENODO_TOKEN_REMOVED,
      resourceId: environment,
      ip,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ConfigEnvironmentStatus {
  configured: boolean;
  hint: string | null;
  last_updated: Date | null;
}

/** Per-environment configuration status (never exposes the token itself). */
export async function getConfigStatus(): Promise<
  Record<ZenodoEnvironment, ConfigEnvironmentStatus>
> {
  const { rows } = await pool.query(
    "SELECT environment, token_hint, updated_at FROM zenodo_config",
  );
  const byEnv = new Map(rows.map((r) => [r.environment, r]));

  const build = (env: ZenodoEnvironment): ConfigEnvironmentStatus => {
    const row = byEnv.get(env);
    return row
      ? { configured: true, hint: row.token_hint, last_updated: row.updated_at }
      : { configured: false, hint: null, last_updated: null };
  };

  return { sandbox: build("sandbox"), production: build("production") };
}
