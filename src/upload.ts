import { RequestHandler } from 'express'
import axios from 'axios'
import { pool } from './db'

const ORTHANC_URL = process.env.ORTHANC_URL ?? 'http://orthanc:8042'
const ORTHANC_USER = process.env.ORTHANC_USERNAME ?? 'orthanc'
const ORTHANC_PASS = process.env.ORTHANC_PASSWORD ?? 'orthanc'
const orthancAuth = { username: ORTHANC_USER, password: ORTHANC_PASS }

const MAX_FILE_SIZE = 500 * 1024 * 1024 // 500 MB

// DICOM files have the magic bytes 'DICM' at offset 128
function isDicom(buf: Buffer): boolean {
  if (buf.length < 132) return false
  return buf[128] === 0x44 && buf[129] === 0x49 && buf[130] === 0x43 && buf[131] === 0x4d
}

// Tags use Latin-1 encoding in old DICOMs — normalize to UTF-8 safe string
function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    return Buffer.from(value, 'latin1').toString('utf8').trim()
  } catch {
    return value.trim()
  }
}

function extractTag(tags: Record<string, any>, tag: string): string {
  return normalizeText(tags[tag]?.Value ?? '')
}

function extractInt(tags: Record<string, any>, tag: string): number | null {
  const v = tags[tag]?.Value?.[0]
  return typeof v === 'number' ? v : null
}

export const uploadStudy: RequestHandler = async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No DICOM file provided (field: file)' })
    return
  }

  // 413 — file too large
  if (req.file.size > MAX_FILE_SIZE) {
    res.status(413).json({ error: 'File exceeds maximum allowed size of 500 MB' })
    return
  }

  // Validate DICOM magic bytes
  if (!isDicom(req.file.buffer)) {
    res.status(400).json({ error: 'El archivo no es un DICOM válido' })
    return
  }

  // Upload to Orthanc
  let orthancData: any
  try {
    const { data } = await axios.post(`${ORTHANC_URL}/instances`, req.file.buffer, {
      auth: orthancAuth,
      headers: { 'Content-Type': 'application/dicom' },
      maxBodyLength: Infinity,
    })
    orthancData = data
  } catch (err: any) {
    if (err.response?.status === 400) {
      res.status(400).json({ error: 'El archivo no es un DICOM válido' })
    } else {
      res.status(503).json({ error: 'Orthanc unavailable', detail: err.message })
    }
    return
  }

  const instanceId: string = orthancData.ID
  const studyId: string = orthancData.ParentStudy
  const isAlreadyStored: boolean = orthancData.Status === 'AlreadyStored'

  // Fetch DICOM tags from Orthanc
  let tags: Record<string, any> = {}
  try {
    const { data } = await axios.get(`${ORTHANC_URL}/instances/${instanceId}/tags`, {
      auth: orthancAuth,
    })
    tags = data
  } catch {
    // non-fatal: proceed without tags
  }

  const sopInstanceUid  = extractTag(tags, '0008,0018')
  const studyInstanceUid = extractTag(tags, '0020,000d')
  const patientName     = extractTag(tags, '0010,0010')
  const patientId       = extractTag(tags, '0010,0020')
  const studyDate       = extractTag(tags, '0008,0020')
  const studyDesc       = extractTag(tags, '0008,1030')
  const rawModality     = extractTag(tags, '0008,0060').toUpperCase()
  const modality        = rawModality || 'OTHER'
  const rows            = extractInt(tags, '0028,0010')
  const cols            = extractInt(tags, '0028,0011')

  // Duplicate detected — ask user before overwriting
  if (isAlreadyStored) {
    const existing = await pool.query(
      'SELECT id, orthanc_study_id FROM studies WHERE sop_instance_uid = $1',
      [sopInstanceUid],
    )
    const force = req.query.force === 'true'

    if (!force) {
      res.status(409).json({
        error: 'duplicate',
        message: 'Ya existe un estudio con este ID. ¿Desea reemplazarlo?',
        sopInstanceUid,
        existingStudyId: existing.rows[0]?.orthanc_study_id ?? studyId,
      })
      return
    }

    // force=true: delete existing record and re-insert
    await pool.query('DELETE FROM studies WHERE sop_instance_uid = $1', [sopInstanceUid])
  }

  // Persist metadata in PostgreSQL
  let inserted: any[]
  try {
    const result = await pool.query(
      `INSERT INTO studies
         (orthanc_study_id, orthanc_instance_id, sop_instance_uid, study_instance_uid,
          patient_name, patient_id, study_date, modality, study_description,
          rows_count, cols_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (sop_instance_uid) DO UPDATE SET
         orthanc_study_id    = EXCLUDED.orthanc_study_id,
         orthanc_instance_id = EXCLUDED.orthanc_instance_id,
         study_instance_uid  = EXCLUDED.study_instance_uid,
         patient_name        = EXCLUDED.patient_name,
         patient_id          = EXCLUDED.patient_id,
         study_date          = EXCLUDED.study_date,
         modality            = EXCLUDED.modality,
         study_description   = EXCLUDED.study_description,
         rows_count          = EXCLUDED.rows_count,
         cols_count          = EXCLUDED.cols_count,
         uploaded_at         = NOW()
       RETURNING *`,
      [studyId, instanceId, sopInstanceUid, studyInstanceUid,
       patientName, patientId, studyDate, modality, studyDesc,
       rows, cols],
    )
    inserted = result.rows
  } catch (err: any) {
    res.status(500).json({ error: 'Error al guardar el estudio en la base de datos', detail: err.message })
    return
  }

  res.status(201).json({ study: inserted[0], orthanc: orthancData })
}
