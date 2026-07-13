import { Router } from 'express'
import { authenticate, requireAdmin } from '../middleware/auth.middleware'
import {
  getSyncConfig,
  setSyncConfig,
  runSync,
  getSyncLogs,
  isValidInterval,
  type SyncInterval,
} from '../services/zenodo-sync.service'

const router = Router()

router.use(authenticate, requireAdmin)

// GET /api/v1/zenodo/config/sync
router.get('/config/sync', async (_req, res) => {
  try {
    const config = await getSyncConfig()
    res.json({
      interval_hours: config.intervalHours,
      last_run_at: config.lastRunAt,
      updated_at: config.updatedAt,
      valid_intervals: [6, 12, 24, 168],
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al obtener la configuración de sincronización:', message)
    res.status(500).json({ error: 'Error al obtener la configuración' })
  }
})

// PUT /api/v1/zenodo/config/sync
// Body: { interval_hours: 6 | 12 | 24 | 168 | null }
router.put('/config/sync', async (req, res) => {
  const { interval_hours } = req.body ?? {}

  if (interval_hours !== null && interval_hours !== undefined && !isValidInterval(interval_hours)) {
    res.status(400).json({
      error: 'interval_hours inválido. Valores permitidos: 6, 12, 24, 168, o null para desactivar',
    })
    return
  }

  try {
    const config = await setSyncConfig((interval_hours ?? null) as SyncInterval | null)
    res.json({
      interval_hours: config.intervalHours,
      last_run_at: config.lastRunAt,
      updated_at: config.updatedAt,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al actualizar la configuración de sincronización:', message)
    res.status(500).json({ error: 'Error al actualizar la configuración' })
  }
})

// POST /api/v1/zenodo/config/sync/run  — manual trigger
router.post('/config/sync/run', async (_req, res) => {
  try {
    const result = await runSync()
    res.json({
      log_id: result.logId,
      records_checked: result.recordsChecked,
      new_versions: result.newVersions,
      errors: result.errors,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error durante la sincronización manual:', message)
    res.status(500).json({ error: 'Error durante la sincronización' })
  }
})

// GET /api/v1/zenodo/config/sync/logs
router.get('/config/sync/logs', async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20))
  try {
    const logs = await getSyncLogs(limit)
    res.json({ logs })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al obtener los logs de sincronización:', message)
    res.status(500).json({ error: 'Error al obtener los logs' })
  }
})

export { router as zenodoSyncRouter }
