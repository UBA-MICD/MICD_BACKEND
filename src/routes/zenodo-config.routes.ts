import { Router } from 'express'
import { pool } from '../db'
import { authenticate, requireAdmin, type AuthenticatedRequest } from '../middleware/auth.middleware'
import {
  ZENODO_ENVIRONMENTS,
  type ZenodoEnvironment,
  type ZenodoHealthRow,
  configureZenodoToken,
  removeZenodoConfig,
  ZenodoTokenError,
} from '../services/zenodo.service'

const router = Router()

function isEnvironment(value: unknown): value is ZenodoEnvironment {
  return typeof value === 'string' && (ZENODO_ENVIRONMENTS as readonly string[]).includes(value)
}

router.use(authenticate, requireAdmin)

router.post('/config', async (req, res) => {
  const { token, environment } = req.body ?? {}
  const { user, ip } = req as AuthenticatedRequest

  if (!isEnvironment(environment)) {
    res.status(400).json({ error: 'environment inválido, debe ser sandbox o production' })
    return
  }
  if (typeof token !== 'string' || token.trim() === '') {
    res.status(400).json({ error: 'token requerido' })
    return
  }

  try {
    const { hint } = await configureZenodoToken(token, environment, user.id, ip ?? '')
    res.status(200).json({ status: 'connected', environment, hint })
  } catch (err: unknown) {
    if (err instanceof ZenodoTokenError) {
      res.status(400).json({ error: err.message, reason: err.reason })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al guardar la configuración de Zenodo:', message)
    res.status(500).json({ error: 'Error al guardar la configuración' })
  }
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
        ? { configured: true, hint: row.token_hint, last_updated: row.updated_at }
        : { configured: false, hint: null, last_updated: null }
    }

    res.json({ sandbox: build('sandbox'), production: build('production') })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al obtener el estado de Zenodo:', message)
    res.status(500).json({ error: 'Error al obtener el estado de configuración' })
  }
})

router.delete('/config/:environment', async (req, res) => {
  const { environment } = req.params
  const { user, ip } = req as AuthenticatedRequest

  if (!isEnvironment(environment)) {
    res.status(400).json({ error: 'environment inválido, debe ser sandbox o production' })
    return
  }

  try {
    await removeZenodoConfig(environment, user.id, ip ?? '')
    res.status(200).json({ message: 'Configuración eliminada' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al eliminar la configuración de Zenodo:', message)
    res.status(500).json({ error: 'Error al eliminar la configuración' })
  }
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
