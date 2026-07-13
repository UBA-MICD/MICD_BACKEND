import { Router } from 'express'
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.middleware'
import { ZENODO_ENVIRONMENTS, type ZenodoEnvironment } from '../services/zenodo.service'
import {
  importFromZenodo,
  getImport,
  getImportFiles,
  type ImportFileSpec,
} from '../services/zenodo-import.service'

const router = Router()

router.use(authenticate)

function isEnvironment(value: unknown): value is ZenodoEnvironment {
  return typeof value === 'string' && (ZENODO_ENVIRONMENTS as readonly string[]).includes(value)
}

function isFileSpecArray(value: unknown): value is ImportFileSpec[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as Record<string, unknown>).fileKey === 'string',
    )
  )
}

// POST /api/v1/zenodo/import
// Body: { record_id, environment, files: [{ fileKey, fileSize? }], overwrite_duplicates? }
router.post('/import', async (req, res) => {
  const { user, ip } = req as AuthenticatedRequest
  const { record_id, environment, files, overwrite_duplicates } = req.body ?? {}

  const recordId = parseInt(record_id, 10)
  if (isNaN(recordId)) {
    res.status(400).json({ error: 'record_id debe ser un número entero' })
    return
  }
  if (!isEnvironment(environment)) {
    res.status(400).json({ error: 'environment inválido, debe ser sandbox o production' })
    return
  }
  if (!isFileSpecArray(files)) {
    res.status(400).json({
      error: 'files debe ser un array no vacío de objetos { fileKey: string, fileSize?: number }',
    })
    return
  }

  // Warn on non-DICOM files — but don't block; service will skip .zip
  const nonDcm = (files as ImportFileSpec[]).filter(
    (f) => !f.fileKey.toLowerCase().endsWith('.dcm') && !f.fileKey.toLowerCase().endsWith('.zip'),
  )
  if (nonDcm.length === files.length) {
    res.status(400).json({
      error: 'Ninguno de los archivos seleccionados es .dcm o .zip',
      files: nonDcm.map((f) => f.fileKey),
    })
    return
  }

  try {
    const result = await importFromZenodo({
      recordId,
      environment,
      files,
      overwriteDuplicates: overwrite_duplicates === true,
      userId: user.id,
      ip: ip ?? '',
    })

    const httpStatus = result.imported > 0 ? 201 : result.duplicates > 0 ? 200 : 422

    res.status(httpStatus).json({
      import_id: result.importId,
      source_doi: result.sourceDoi,
      imported: result.imported,
      duplicates: result.duplicates,
      failed: result.failed,
      results: result.results,
      ...(result.largeSizeWarning
        ? { warning: 'El dataset supera los 10 GB. La descarga puede tardar varios minutos.' }
        : {}),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al importar desde Zenodo:', message)
    res.status(500).json({ error: 'Error interno al importar el dataset' })
  }
})

// GET /api/v1/zenodo/imports/:importId
router.get('/imports/:importId', async (req, res) => {
  const importId = parseInt(req.params.importId, 10)
  if (isNaN(importId)) {
    res.status(400).json({ error: 'importId inválido' })
    return
  }

  try {
    const importJob = await getImport(importId)
    if (!importJob) {
      res.status(404).json({ error: 'Importación no encontrada' })
      return
    }
    const files = await getImportFiles(importId)
    res.json({ import: importJob, files })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Error al obtener la importación:', message)
    res.status(500).json({ error: 'Error al obtener el estado de la importación' })
  }
})

export { router as zenodoImportRouter }
