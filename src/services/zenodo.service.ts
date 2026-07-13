import axios from 'axios'
import { pool } from '../db'
import { decrypt, encrypt } from './encryption.service'
import { AUDIT_ACTIONS, logActionWithClient } from './audit.service'

export const ZENODO_ENVIRONMENTS = ['sandbox', 'production'] as const
export type ZenodoEnvironment = (typeof ZENODO_ENVIRONMENTS)[number]

const RECORDS_URL: Record<ZenodoEnvironment, string> = {
  sandbox: 'https://sandbox.zenodo.org/api/records',
  production: 'https://zenodo.org/api/records',
}

export type ValidateTokenResult =
  | { valid: true }
  | { valid: false; reason: 'invalid_token' | 'insufficient_permissions' | 'timeout' | 'unknown_error' }

// NOTE: never log the raw error here — axios embeds the token in the request
// URL/config, and logging it would leak the token to the server logs.
export async function validateToken(
  token: string,
  environment: ZenodoEnvironment,
): Promise<ValidateTokenResult> {
  const timeout = parseInt(process.env.ZENODO_TIMEOUT_MS ?? '10000', 10)

  try {
    await axios.get(RECORDS_URL[environment], {
      params: { size: 1, access_token: token },
      timeout,
    })
    return { valid: true }
  } catch (err: unknown) {
    const e = err as Record<string, unknown>
    if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
      return { valid: false, reason: 'timeout' }
    }
    const status = (e?.response as Record<string, unknown>)?.status
    if (status === 401) return { valid: false, reason: 'invalid_token' }
    if (status === 403) return { valid: false, reason: 'insufficient_permissions' }
    return { valid: false, reason: 'unknown_error' }
  }
}

export async function getStoredToken(environment: ZenodoEnvironment): Promise<string | null> {
  const { rows } = await pool.query(
    'SELECT token_encrypted FROM zenodo_config WHERE environment = $1',
    [environment],
  )
  if (rows.length === 0) return null
  return decrypt(rows[0].token_encrypted)
}

export type ZenodoHealthStatus = 'connected' | 'error' | 'unconfigured'

export interface ZenodoHealthRow {
  environment: ZenodoEnvironment
  status: ZenodoHealthStatus
  error_reason: string | null
  last_checked: Date
  last_success: Date | null
}

export async function checkHealth(environment: ZenodoEnvironment): Promise<ZenodoHealthRow> {
  const token = await getStoredToken(environment)

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
    )
    return rows[0]
  }

  const result = await validateToken(token, environment)

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
    )
    return rows[0]
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
  )
  return rows[0]
}

export async function checkAllEnvironments(): Promise<void> {
  await Promise.all((['sandbox', 'production'] as ZenodoEnvironment[]).map(checkHealth))
}

function maskToken(token: string): string {
  return token.length <= 4 ? 'xxxx' : `xxxx...${token.slice(-4)}`
}

export class ZenodoTokenError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message)
    this.name = 'ZenodoTokenError'
  }
}

export async function configureZenodoToken(
  token: string,
  environment: ZenodoEnvironment,
  userId: number,
  ip: string,
): Promise<{ hint: string }> {
  const result = await validateToken(token, environment)
  if (!result.valid) {
    throw new ZenodoTokenError('Token inválido', result.reason)
  }

  const encrypted = encrypt(token)
  const hint = maskToken(token)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO zenodo_config (environment, token_encrypted, token_hint, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW())
       ON CONFLICT (environment) DO UPDATE SET
         token_encrypted = EXCLUDED.token_encrypted,
         token_hint      = EXCLUDED.token_hint,
         created_by      = EXCLUDED.created_by,
         updated_at      = NOW()`,
      [environment, encrypted, hint, userId],
    )
    await logActionWithClient(client, {
      userId,
      action: AUDIT_ACTIONS.ZENODO_TOKEN_CONFIGURED,
      resourceId: environment,
      ip,
    })
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return { hint }
}

export async function removeZenodoConfig(
  environment: ZenodoEnvironment,
  userId: number,
  ip: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM zenodo_config WHERE environment = $1', [environment])
    await logActionWithClient(client, {
      userId,
      action: AUDIT_ACTIONS.ZENODO_TOKEN_REMOVED,
      resourceId: environment,
      ip,
    })
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
