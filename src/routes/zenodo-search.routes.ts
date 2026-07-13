import { Router, type Request } from 'express'
import { ZENODO_ENVIRONMENTS, type ZenodoEnvironment } from '../services/zenodo.service'
import { searchZenodo, getZenodoRecord } from '../services/zenodo-search.service'

const router = Router()

function isEnvironment(value: unknown): value is ZenodoEnvironment {
  return typeof value === 'string' && (ZENODO_ENVIRONMENTS as readonly string[]).includes(value)
}

function parseEnvironment(req: Request): ZenodoEnvironment {
  const env = req.query.environment as string
  return isEnvironment(env) ? env : 'production'
}

// GET /api/v1/zenodo/search
// Query params: q, page, size, file_type, license, date_from, date_to, keywords, environment
router.get('/search', async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim() ?? ''

  if (!q) {
    res.status(400).json({ error: 'El parámetro q es requerido' })
    return
  }

  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const size = Math.min(100, Math.max(1, parseInt(req.query.size as string) || 20))
  const environment = parseEnvironment(req)

  try {
    const result = await searchZenodo(
      {
        q,
        page,
        size,
        fileType: (req.query.file_type as string) || undefined,
        license: (req.query.license as string) || undefined,
        dateFrom: (req.query.date_from as string) || undefined,
        dateTo: (req.query.date_to as string) || undefined,
        keywords: (req.query.keywords as string) || undefined,
      },
      environment,
    )

    if (result.records.length === 0) {
      res.json({
        ...result,
        message: 'No se encontraron datasets con esos términos',
        suggestions: [
          'Probá términos más generales (ej: "DICOM" en lugar de "CT lung DICOM")',
          'Remové filtros de tipo de archivo o licencia',
          'Revisá la ortografía',
        ],
      })
      return
    }

    res.json(result)
  } catch (err: unknown) {
    const axiosErr = err as any
    if (axiosErr?.response?.status === 429) {
      res.status(429).json({
        error: 'Límite de requests a Zenodo alcanzado. Intentá de nuevo en unos minutos.',
        retryAfter: axiosErr.response.headers?.['retry-after'],
      })
      return
    }
    const isNetworkErr =
      axiosErr?.code === 'ECONNABORTED' ||
      axiosErr?.code === 'ECONNREFUSED' ||
      axiosErr?.code === 'ETIMEDOUT'
    if (isNetworkErr || axiosErr?.response?.status >= 500) {
      res.status(503).json({
        error: 'Zenodo no está disponible en este momento. Intentá de nuevo más tarde.',
      })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al buscar en Zenodo:', message)
    res.status(500).json({ error: 'Error al realizar la búsqueda' })
  }
})

// GET /api/v1/zenodo/records/:recordId
// Query params: environment
router.get('/records/:recordId', async (req, res) => {
  const recordId = parseInt(req.params.recordId, 10)
  if (isNaN(recordId)) {
    res.status(400).json({ error: 'recordId inválido' })
    return
  }

  const environment = parseEnvironment(req)

  try {
    const record = await getZenodoRecord(recordId, environment)

    if (!record.importable) {
      res.json({
        ...record,
        importNote:
          'Este dataset no contiene archivos .dcm ni .zip. No puede ser importado directamente al sistema.',
      })
      return
    }

    res.json(record)
  } catch (err: unknown) {
    const axiosErr = err as any
    if (axiosErr?.response?.status === 404) {
      res.status(404).json({ error: 'Record no encontrado en Zenodo' })
      return
    }
    const isNetworkErr =
      axiosErr?.code === 'ECONNABORTED' ||
      axiosErr?.code === 'ECONNREFUSED' ||
      axiosErr?.code === 'ETIMEDOUT'
    if (isNetworkErr || axiosErr?.response?.status >= 500) {
      res.status(503).json({
        error: 'Zenodo no está disponible en este momento. Intentá de nuevo más tarde.',
      })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al obtener el record de Zenodo:', message)
    res.status(500).json({ error: 'Error al obtener el detalle del record' })
  }
})

export { router as zenodoSearchRouter }
