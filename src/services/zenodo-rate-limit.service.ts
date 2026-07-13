import { pool } from '../db'
import { type ZenodoEnvironment } from './zenodo.service'

// Pause new requests when we've made this many in the last 60 seconds.
// Zenodo allows 60/min authenticated, 30/min anonymous — 50 gives a safe margin.
export const THROTTLE_AT = 50
export const FIFTY_GB = 50 * 1024 * 1024 * 1024

const WINDOW_MS = 60_000
const QUOTA_ALERT_THRESHOLD = 0.9

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pruneOldRequests(): Promise<void> {
  await pool.query(
    "DELETE FROM zenodo_api_requests WHERE requested_at < NOW() - INTERVAL '60 seconds'",
  )
}

export async function getRequestCount(environment: ZenodoEnvironment): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM zenodo_api_requests
     WHERE environment = $1 AND requested_at > NOW() - INTERVAL '60 seconds'`,
    [environment],
  )
  return parseInt(rows[0].count, 10)
}

async function recordRequest(environment: ZenodoEnvironment): Promise<void> {
  await pool.query('INSERT INTO zenodo_api_requests (environment) VALUES ($1)', [environment])
}

/**
 * Call this before every Zenodo API request.
 * If the sliding-window counter is at or above THROTTLE_AT (50/min),
 * sleeps until the oldest request in the window expires, then records the new request.
 */
export async function throttle(environment: ZenodoEnvironment): Promise<void> {
  await pruneOldRequests()

  const count = await getRequestCount(environment)
  if (count >= THROTTLE_AT) {
    const { rows } = await pool.query<{ oldest: Date }>(
      `SELECT MIN(requested_at) AS oldest
       FROM zenodo_api_requests
       WHERE environment = $1 AND requested_at > NOW() - INTERVAL '60 seconds'`,
      [environment],
    )
    if (rows[0]?.oldest) {
      const expiresAt = new Date(rows[0].oldest.getTime() + WINDOW_MS)
      const waitMs = Math.max(0, expiresAt.getTime() - Date.now()) + 100
      await sleep(waitMs)
    }
  }

  await recordRequest(environment)
}

export interface QuotaStatus {
  usedBytes: number
  limitBytes: number
  percentUsed: number
  alert: boolean
  alertMessage: string | null
}

/**
 * Estimates Zenodo storage usage from locally recorded file sizes.
 * Compares against ZENODO_QUOTA_LIMIT_GB (default 50 GB).
 */
export async function getQuotaStatus(environment: ZenodoEnvironment): Promise<QuotaStatus> {
  const limitBytes =
    parseInt(process.env.ZENODO_QUOTA_LIMIT_GB ?? '50', 10) * 1024 * 1024 * 1024

  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(f.file_size), 0) AS total
     FROM zenodo_deposition_files f
     JOIN zenodo_depositions d ON d.id = f.deposition_id
     WHERE d.status = 'published' AND d.environment = $1`,
    [environment],
  )

  const usedBytes = parseInt(rows[0].total, 10)
  const percentUsed = limitBytes > 0 ? usedBytes / limitBytes : 0

  const alert = percentUsed >= QUOTA_ALERT_THRESHOLD
  const alertMessage = alert
    ? `⚠ Cuota de Zenodo al ${Math.round(percentUsed * 100)}% — contactar al administrador de la cuenta`
    : null

  return { usedBytes, limitBytes, percentUsed, alert, alertMessage }
}
