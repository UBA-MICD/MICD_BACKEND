import express from 'express'
import cors from 'cors'
import multer from 'multer'
import axios from 'axios'
import { pool, initDb } from './db'
import { uploadStudy } from './upload'

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

// ── Upload (v1) ───────────────────────────────────────────────────────────────
app.post('/api/v1/studies/upload', upload.single('file'), uploadStudy)

// ── Studies from DB (v1) ──────────────────────────────────────────────────────
app.get('/api/v1/studies', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM studies ORDER BY uploaded_at DESC',
    )
    res.json(rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Legacy upload (kept for backward compat) ──────────────────────────────────
app.post('/api/instances', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No DICOM file provided (field: file)' })
    return
  }
  try {
    const { data } = await axios.post(`${ORTHANC_URL}/instances`, req.file.buffer, {
      auth: orthancAuth,
      headers: { 'Content-Type': 'application/dicom' },
      maxBodyLength: Infinity,
    })
    res.status(201).json(data)
  } catch (err: any) {
    if (err.response?.status === 400) {
      res.status(400).json({ error: 'Invalid DICOM file' })
    } else {
      res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
    }
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`MICD backend listening on port ${PORT}`))
  })
  .catch((err) => {
    console.error('Failed to initialize DB:', err)
    process.exit(1)
  })

export { app }
