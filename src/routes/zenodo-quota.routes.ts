import { Router } from 'express'
import { authenticate, requireAdmin } from '../middleware/auth.middleware'
import { ZENODO_ENVIRONMENTS, type ZenodoEnvironment } from '../services/zenodo.service'
import { getQuotaStatus, getRequestCount } from '../services/zenodo-rate-limit.service'

const router = Router()

router.use(authenticate, requireAdmin)

// GET /api/v1/zenodo/quota?environment=production
router.get('/quota', async (req, res) => {
  const environment = (req.query.environment as string) ?? 'production'

  if (!(ZENODO_ENVIRONMENTS as readonly string[]).includes(environment)) {
    res.status(400).json({ error: 'environment inválido, debe ser sandbox o production' })
    return
  }

  try {
    const [quota, requestCount] = await Promise.all([
      getQuotaStatus(environment as ZenodoEnvironment),
      getRequestCount(environment as ZenodoEnvironment),
    ])

    res.json({
      environment,
      used_bytes: quota.usedBytes,
      limit_bytes: quota.limitBytes,
      percent_used: Math.round(quota.percentUsed * 1000) / 10,
      alert: quota.alert,
      alert_message: quota.alertMessage,
      rate_limit: {
        requests_last_minute: requestCount,
        throttle_at: 50,
        limit: environment === 'production' ? 60 : 60,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al consultar la cuota de Zenodo:', message)
    res.status(500).json({ error: 'Error al consultar el estado de la cuota' })
  }
})

export { router as zenodoQuotaRouter }
