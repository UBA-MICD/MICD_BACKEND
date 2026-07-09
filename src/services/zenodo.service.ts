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
