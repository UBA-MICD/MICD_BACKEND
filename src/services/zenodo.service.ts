import axios from 'axios'
import { pool } from '../db'
import { decrypt } from './encryption.service'

export type ZenodoEnvironment = 'sandbox' | 'production'

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
  } catch (err: any) {
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
      return { valid: false, reason: 'timeout' }
    }
    const status = err?.response?.status
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
