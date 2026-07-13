import { Router } from 'express'
import { pool } from '../db'
import { authenticate, requireAdmin, type AuthenticatedRequest } from '../middleware/auth.middleware'
import {
  ZENODO_ENVIRONMENTS,
  type ZenodoEnvironment,
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

export { router as zenodoConfigRouter }
