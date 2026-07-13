import { Router } from 'express'
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.middleware'
import { ZENODO_ENVIRONMENTS, type ZenodoEnvironment } from '../services/zenodo.service'
import {
  publishStudy,
  retryFailedFiles,
  getDeposition,
  getDepositionFiles,
  ZenodoPublishError,
  type ZenodoAuthor,
} from '../services/zenodo-publish.service'

const router = Router()

router.use(authenticate)

function isEnvironment(value: unknown): value is ZenodoEnvironment {
  return typeof value === 'string' && (ZENODO_ENVIRONMENTS as readonly string[]).includes(value)
}

function isAuthorArray(value: unknown): value is ZenodoAuthor[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as Record<string, unknown>).name === 'string',
    )
  )
}

// POST /api/v1/zenodo/publish
// Body: { orthanc_study_id, environment, title, description, authors, license?, keywords? }
router.post('/publish', async (req, res) => {
  const { user, ip } = req as AuthenticatedRequest
  const { orthanc_study_id, environment, title, description, authors, license, keywords } =
    req.body ?? {}

  if (typeof orthanc_study_id !== 'string' || orthanc_study_id.trim() === '') {
    res.status(400).json({ error: 'orthanc_study_id requerido' })
    return
  }
  if (!isEnvironment(environment)) {
    res.status(400).json({ error: 'environment inválido, debe ser sandbox o production' })
    return
  }
  if (typeof title !== 'string' || title.trim() === '') {
    res.status(400).json({ error: 'title requerido' })
    return
  }
  if (typeof description !== 'string' || description.trim() === '') {
    res.status(400).json({ error: 'description requerida' })
    return
  }
  if (!isAuthorArray(authors) || authors.length === 0) {
    res.status(400).json({ error: 'authors debe ser un array no vacío con al menos { name }' })
    return
  }
  if (keywords !== undefined && !Array.isArray(keywords)) {
    res.status(400).json({ error: 'keywords debe ser un array de strings' })
    return
  }

  try {
    const result = await publishStudy({
      orthancStudyId: orthanc_study_id,
      environment,
      metadata: { title, description, authors, license, keywords },
      userId: user.id,
      ip: ip ?? '',
    })

    res.status(201).json({
      deposition_id: result.depositionId,
      doi: result.doi,
      files_uploaded: result.filesUploaded,
      ...(result.largeSizeWarning
        ? { warning: 'El dataset supera los 50 GB. La subida puede tardar significativamente.' }
        : {}),
    })
  } catch (err: unknown) {
    if (err instanceof ZenodoPublishError) {
      const status =
        err.code === 'study_not_found'
          ? 404
          : err.code === 'not_anonymized' || err.code === 'no_credentials'
            ? 422
            : 400
      res.status(status).json({ error: err.message, code: err.code })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al publicar en Zenodo:', message)
    res.status(500).json({ error: 'Error interno al publicar el estudio' })
  }
})

// GET /api/v1/zenodo/depositions/:depositionId
router.get('/depositions/:depositionId', async (req, res) => {
  const depositionId = parseInt(req.params.depositionId, 10)
  if (isNaN(depositionId)) {
    res.status(400).json({ error: 'depositionId inválido' })
    return
  }

  try {
    const deposition = await getDeposition(depositionId)
    if (!deposition) {
      res.status(404).json({ error: 'Depósito no encontrado' })
      return
    }
    const files = await getDepositionFiles(depositionId)
    res.json({ deposition, files })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al obtener el depósito:', message)
    res.status(500).json({ error: 'Error al obtener el estado del depósito' })
  }
})

// POST /api/v1/zenodo/depositions/:depositionId/retry
router.post('/depositions/:depositionId/retry', async (req, res) => {
  const { user, ip } = req as AuthenticatedRequest
  const depositionId = parseInt(req.params.depositionId, 10)
  if (isNaN(depositionId)) {
    res.status(400).json({ error: 'depositionId inválido' })
    return
  }

  try {
    const result = await retryFailedFiles(depositionId, user.id, ip ?? '')
    res.json({ retried: result.retried, failed: result.failed })
  } catch (err: unknown) {
    if (err instanceof ZenodoPublishError) {
      const status = err.code === 'deposition_not_found' ? 404 : 422
      res.status(status).json({ error: err.message, code: err.code })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al reintentar archivos fallidos:', message)
    res.status(500).json({ error: 'Error al reintentar la subida' })
  }
})

export { router as zenodoPublishRouter }
