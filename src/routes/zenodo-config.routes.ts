import { Router } from 'express'
import { pool } from '../db'
import { authenticate, requireAdmin } from '../middleware/auth.middleware'
import { encrypt } from '../services/encryption.service'
import { validateToken, ZenodoEnvironment, ZenodoHealthRow } from '../services/zenodo.service'
import { logAction } from '../services/audit.service'

const router = Router()

const ENVIRONMENTS: ZenodoEnvironment[] = ['sandbox', 'production']

function isEnvironment(value: unknown): value is ZenodoEnvironment {
  return typeof value === 'string' && (ENVIRONMENTS as string[]).includes(value)
}

function maskToken(token: string): string {
  return `xxxx...${token.slice(-4)}`
}

router.use(authenticate, requireAdmin)

router.post('/config', async (req, res) => {
  const { token, environment, expires_at } = req.body ?? {}

  if (!isEnvironment(environment)) {
    res.status(400).json({ error: 'environment inválido, debe ser sandbox o production' })
    return
  }
  if (typeof token !== 'string' || token.trim() === '') {
    res.status(400).json({ error: 'token requerido' })
    return
  }

  let tokenExpiresAt: Date | null = null
  if (expires_at !== undefined && expires_at !== null) {
    const parsed = new Date(expires_at)
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'expires_at inválido, debe ser una fecha ISO 8601' })
      return
    }
    tokenExpiresAt = parsed
  }

  const result = await validateToken(token, environment)
  if (!result.valid) {
    res.status(400).json({ error: 'Token inválido', reason: result.reason })
    return
  }

  const encrypted = encrypt(token)
  const hint = maskToken(token)

  try {
    await pool.query(
      `INSERT INTO zenodo_config (environment, token_encrypted, token_hint, token_expires_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
       ON CONFLICT (environment) DO UPDATE SET
         token_encrypted  = EXCLUDED.token_encrypted,
         token_hint       = EXCLUDED.token_hint,
         token_expires_at = EXCLUDED.token_expires_at,
         created_by       = EXCLUDED.created_by,
         updated_at       = NOW()`,
      [environment, encrypted, hint, tokenExpiresAt, req.user!.id],
    )
  } catch (err: any) {
    console.error('Error al guardar la configuración de Zenodo:', err.message)
    res.status(500).json({ error: 'Error al guardar la configuración' })
    return
  }

  await logAction({
    userId: req.user!.id,
    action: 'ZENODO_TOKEN_CONFIGURED',
    resourceId: environment,
    ip: req.ip ?? '',
  })

  res.status(200).json({ status: 'connected', environment, hint })
})

router.get('/config/status', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT environment, token_hint, updated_at FROM zenodo_config',
    )
    const byEnv = new Map(rows.map((r) => [r.environment, r]))

    const build = (env: ZenodoEnvironment) => {
      const row = byEnv.get(env)
      return row
        ? { configured: true, hint: row.token_hint, last_validated: row.updated_at }
        : { configured: false, hint: null, last_validated: null }
    }

    res.json({ sandbox: build('sandbox'), production: build('production') })
  } catch (err: any) {
    console.error('Error al obtener el estado de Zenodo:', err.message)
    res.status(500).json({ error: 'Error al obtener el estado de configuración' })
  }
})

router.delete('/config/:environment', async (req, res) => {
  const { environment } = req.params

  if (!isEnvironment(environment)) {
    res.status(400).json({ error: 'environment inválido, debe ser sandbox o production' })
    return
  }

  try {
    await pool.query('DELETE FROM zenodo_config WHERE environment = $1', [environment])
  } catch (err: any) {
    console.error('Error al eliminar la configuración de Zenodo:', err.message)
    res.status(500).json({ error: 'Error al eliminar la configuración' })
    return
  }

  await logAction({
    userId: req.user!.id,
    action: 'ZENODO_TOKEN_REMOVED',
    resourceId: environment,
    ip: req.ip ?? '',
  })

  res.status(200).json({ message: 'Configuración eliminada' })
})

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

// No auth required — returns no sensitive data
router.get('/health', async (_req, res) => {
  try {
    const { rows: healthRows } = await pool.query<ZenodoHealthRow>(
      'SELECT environment, status, error_reason, last_checked, last_success FROM zenodo_health',
    )
    const { rows: configRows } = await pool.query<{
      environment: ZenodoEnvironment
      token_expires_at: Date | null
    }>('SELECT environment, token_expires_at FROM zenodo_config')

    const healthByEnv = new Map(healthRows.map((r) => [r.environment, r]))
    const configByEnv = new Map(configRows.map((r) => [r.environment, r]))

    const build = (env: ZenodoEnvironment) => {
      const health = healthByEnv.get(env)
      const config = configByEnv.get(env)
      const tokenExpiresAt = config?.token_expires_at ?? null
      const tokenExpiryWarning =
        tokenExpiresAt !== null &&
        new Date(tokenExpiresAt).getTime() - Date.now() < THIRTY_DAYS_MS

      if (!health) {
        return {
          status: 'unconfigured' as const,
          last_checked: null,
          last_success: null,
          error_reason: null,
          token_expiry_warning: tokenExpiryWarning,
          token_expires_at: tokenExpiresAt,
        }
      }

      return {
        status: health.status,
        last_checked: health.last_checked,
        last_success: health.last_success,
        error_reason: health.error_reason,
        token_expiry_warning: tokenExpiryWarning,
        token_expires_at: tokenExpiresAt,
      }
    }

    res.json({ sandbox: build('sandbox'), production: build('production') })
  } catch (err: any) {
    console.error('Error al obtener el estado de salud de Zenodo:', err.message)
    res.status(500).json({ error: 'Error al obtener el estado de salud' })
  }
})

export { router as zenodoConfigRouter }
