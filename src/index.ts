import express from 'express'
import cors from 'cors'
import { Pool } from 'pg'
import axios from 'axios'

const app = express()
const PORT = parseInt(process.env.PORT ?? '3000', 10)

const ORTHANC_URL = process.env.ORTHANC_URL ?? 'http://orthanc:8042'
const ORTHANC_USER = process.env.ORTHANC_USERNAME ?? 'orthanc'
const ORTHANC_PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc'

const pool = new Pool({
  host: process.env.DB_HOST ?? 'postgres',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME ?? 'micd',
  user: process.env.DB_USER ?? 'micd',
  password: process.env.DB_PASSWORD ?? 'micd',
})

app.use(cors())
app.use(express.json())

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    const orthanc = await axios.get(`${ORTHANC_URL}/system`, {
      auth: { username: ORTHANC_USER, password: ORTHANC_PASS },
      timeout: 3000,
    })
    res.json({ status: 'ok', orthanc: orthanc.data.Version })
  } catch (err: any) {
    res.status(503).json({ status: 'degraded', error: err.message })
  }
})

// Proxy Orthanc studies list
app.get('/api/studies', async (_req, res) => {
  try {
    const { data } = await axios.get(`${ORTHANC_URL}/studies`, {
      auth: { username: ORTHANC_USER, password: ORTHANC_PASS },
    })
    res.json(data)
  } catch (err: any) {
    res.status(502).json({ error: err.message })
  }
})

app.get('/api/studies/:id', async (req, res) => {
  try {
    const { data } = await axios.get(`${ORTHANC_URL}/studies/${req.params.id}`, {
      auth: { username: ORTHANC_USER, password: ORTHANC_PASS },
    })
    res.json(data)
  } catch (err: any) {
    res.status(502).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`MICD backend listening on port ${PORT}`)
})
