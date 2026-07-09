import express from 'express'
import cors from 'cors'
import multer from 'multer'
import axios from 'axios'
import { pool, initDb } from './db'
import { uploadStudy } from './upload'
import { buildInstancesPayload, type InstanceRow } from './instances-util'
import { assertEncryptionKeyConfigured } from './services/encryption.service'
import { zenodoConfigRouter } from './routes/zenodo-config.routes'

const app = express()
const PORT = parseInt(process.env.PORT ?? '3000', 10)

const ORTHANC_URL = process.env.ORTHANC_URL ?? 'http://orthanc:8042'
const ORTHANC_USER = process.env.ORTHANC_USERNAME ?? 'orthanc'
const ORTHANC_PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc'
const orthancAuth = { username: ORTHANC_USER, password: ORTHANC_PASS }

// multer: store in memory, no size limit here (validated in handler)
const upload = multer({ storage: multer.memoryStorage() })

app.use(cors())
app.use(express.json())

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    const orthanc = await axios.get(`${ORTHANC_URL}/system`, {
      auth: orthancAuth,
      timeout: 3000,
    })
    res.json({ status: 'ok', orthanc: orthanc.data.Version })
  } catch (err: any) {
    res.status(503).json({ status: 'degraded', error: err.message })
  }
})

// ── Studies (Orthanc proxy) ───────────────────────────────────────────────────
app.get('/api/studies', async (_req, res) => {
  try {
    const { data } = await axios.get(`${ORTHANC_URL}/studies`, { auth: orthancAuth })
    res.json(data)
  } catch (err: any) {
    res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
  }
})

app.get('/api/studies/:id', async (req, res) => {
  try {
    const { data } = await axios.get(`${ORTHANC_URL}/studies/${req.params.id}`, {
      auth: orthancAuth,
    })
    res.json(data)
  } catch (err: any) {
    if (err.response?.status === 404) {
      res.status(404).json({ error: 'Study not found' })
    } else {
      res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
    }
  }
})

app.delete('/api/studies/:id', async (req, res) => {
  try {
    await axios.delete(`${ORTHANC_URL}/studies/${req.params.id}`, { auth: orthancAuth })
    res.status(204).send()
  } catch (err: any) {
    if (err.response?.status === 404) {
      res.status(404).json({ error: 'Study not found' })
    } else {
      res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
    }
  }
})

// ── DICOM file download (v1) ──────────────────────────────────────────────────
app.get('/api/v1/studies/:studyId/file', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT orthanc_instance_id FROM studies WHERE orthanc_study_id = $1 ORDER BY id ASC LIMIT 1',
      [req.params.studyId],
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Study not found' })
      return
    }
    const instanceId: string = rows[0].orthanc_instance_id
    const { data } = await axios.get<ArrayBuffer>(
      `${ORTHANC_URL}/instances/${instanceId}/file`,
      { auth: orthancAuth, responseType: 'arraybuffer' },
    )
    res.setHeader('Content-Type', 'application/dicom')
    res.send(Buffer.from(data))
  } catch (err: any) {
    if (err.response?.status === 404) {
      res.status(404).json({ error: 'Instance not found in Orthanc' })
    } else {
      res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
    }
  }
})

// ── Study instances (v1) — ordered list so the viewer can walk every image ─────
app.get('/api/v1/studies/:studyId/instances', async (req, res) => {
  try {
    const { rows } = await pool.query<InstanceRow>(
      'SELECT id, orthanc_instance_id, instance_number FROM studies WHERE orthanc_study_id = $1',
      [req.params.studyId],
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Study not found' })
      return
    }
    res.json(buildInstancesPayload(req.params.studyId, rows))
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Single instance DICOM file (v1) ────────────────────────────────────────────
app.get('/api/v1/studies/:studyId/instances/:instanceId/file', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM studies WHERE orthanc_study_id = $1 AND orthanc_instance_id = $2 LIMIT 1',
      [req.params.studyId, req.params.instanceId],
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Instance not found' })
      return
    }
    const { data } = await axios.get<ArrayBuffer>(
      `${ORTHANC_URL}/instances/${req.params.instanceId}/file`,
      { auth: orthancAuth, responseType: 'arraybuffer' },
    )
    res.setHeader('Content-Type', 'application/dicom')
    res.send(Buffer.from(data))
  } catch (err: any) {
    if (err.response?.status === 404) {
      res.status(404).json({ error: 'Instance not found in Orthanc' })
    } else {
      res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
    }
  }
})

// ── Upload (v1) ───────────────────────────────────────────────────────────────
app.post('/api/v1/studies/upload', upload.single('file'), uploadStudy)

// ── Studies from DB — paginated, filtered (v1) ────────────────────────────────
app.get('/api/v1/studies', async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page     as string) || 1)
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20))
    const offset   = (page - 1) * limit
    const modality = (req.query.modality  as string) || null
    const dateFrom = (req.query.date_from as string) || null
    const dateTo   = (req.query.date_to   as string) || null
    const search   = (req.query.search    as string) || null

    const filterArgs = [modality, dateFrom, dateTo, search]
    const filterWhere = `
      ($1::text IS NULL OR modality = $1)
      AND ($2::text IS NULL OR study_date >= $2)
      AND ($3::text IS NULL OR study_date <= $3)
      AND (
        $4::text IS NULL
        OR patient_name ILIKE '%' || $4 || '%'
        OR patient_id   ILIKE '%' || $4 || '%'
      )`

    const { rows: countRows } = await pool.query<{ total: string }>(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT orthanc_study_id FROM studies
        WHERE ${filterWhere}
        GROUP BY orthanc_study_id
      ) sub
    `, filterArgs)
    const total = parseInt(countRows[0].total, 10)

    const { rows } = await pool.query<Record<string, any>>(`
      SELECT
        MIN(id)                  AS id,
        orthanc_study_id,
        MIN(orthanc_instance_id) AS orthanc_instance_id,
        MAX(patient_name)        AS patient_name,
        MAX(patient_id)          AS patient_id,
        MAX(study_date)          AS study_date,
        MAX(modality)            AS modality,
        MAX(study_description)   AS study_description,
        MAX(uploaded_at)         AS uploaded_at,
        COUNT(*)                 AS num_instances
      FROM studies
      WHERE ${filterWhere}
      GROUP BY orthanc_study_id
      ORDER BY MAX(uploaded_at) DESC
      LIMIT $5 OFFSET $6
    `, [...filterArgs, limit, offset])

    const studies = rows

    res.json({ studies, total, page, limit, totalPages: Math.ceil(total / limit) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Study thumbnail (v1) ──────────────────────────────────────────────────────
app.get('/api/v1/studies/:studyId/thumbnail', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT orthanc_instance_id FROM studies WHERE orthanc_study_id = $1 ORDER BY id ASC LIMIT 1',
      [req.params.studyId],
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Study not found' })
      return
    }
    const instanceId: string = rows[0].orthanc_instance_id
    const { data, headers } = await axios.get<ArrayBuffer>(
      `${ORTHANC_URL}/instances/${instanceId}/preview`,
      { auth: orthancAuth, responseType: 'arraybuffer' },
    )
    res.setHeader('Content-Type', (headers['content-type'] as string) ?? 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(Buffer.from(data))
  } catch (err: any) {
    if (err.response?.status === 404) {
      res.status(404).json({ error: 'Instance not found in Orthanc' })
    } else if (err.response?.status === 415 || err.response?.status === 400) {
      // Orthanc cannot render a preview for this DICOM type (e.g. RT-STRUCT, SR)
      res.status(422).json({ error: 'Preview not available for this DICOM type' })
    } else {
      res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
    }
  }
})

// ── Legacy upload — delegates to uploadStudy so instances appear in the explorer ──
app.post('/api/instances', upload.single('file'), uploadStudy)

// ── Zenodo credentials configuration (ZEN-01) ─────────────────────────────────
app.use('/api/v1/zenodo', zenodoConfigRouter)

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  assertEncryptionKeyConfigured()
} catch (err: any) {
  console.error(err.message)
  process.exit(1)
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`MICD backend listening on port ${PORT}`))
  })
  .catch((err) => {
    console.error('Failed to initialize DB:', err)
    process.exit(1)
  })

export { app }
