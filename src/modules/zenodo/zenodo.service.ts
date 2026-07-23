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
