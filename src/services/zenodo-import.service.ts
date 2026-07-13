import axios from 'axios'
import { pool } from '../db'
import { type ZenodoEnvironment, getStoredToken } from './zenodo.service'
import { AUDIT_ACTIONS } from './audit.service'
import { throttle } from './zenodo-rate-limit.service'

const TEN_GB = 10 * 1024 * 1024 * 1024

const BASE_URL: Record<ZenodoEnvironment, string> = {
  sandbox: 'https://sandbox.zenodo.org/api',
  production: 'https://zenodo.org/api',
}

const ORTHANC_URL = process.env.ORTHANC_URL ?? 'http://orthanc:8042'
const orthancAuth = {
  username: process.env.ORTHANC_USERNAME ?? 'orthanc',
  password: process.env.ORTHANC_PASSWORD ?? 'orthanc',
}

export interface ImportFileSpec {
  fileKey: string
  fileSize?: number
}

export interface ImportOptions {
  recordId: number
  environment: ZenodoEnvironment
  files: ImportFileSpec[]
  overwriteDuplicates?: boolean
  userId: number
  ip: string
}

export type FileImportStatus = 'imported' | 'duplicate' | 'failed' | 'skipped'

export interface FileImportResult {
  fileKey: string
  status: FileImportStatus
  orthancStudyId?: string
  sopInstanceUid?: string
  existingStudyId?: string
  error?: string
}

export interface ImportResult {
  importId: number
  sourceDoi: string | null
  results: FileImportResult[]
  imported: number
  duplicates: number
  failed: number
  largeSizeWarning: boolean
}

export interface ImportRow {
  id: number
  record_id: number
  environment: ZenodoEnvironment
  source_doi: string | null
  status: 'pending' | 'in_progress' | 'completed' | 'partial' | 'failed'
  total_files: number
  imported_files: number
  duplicate_files: number
  failed_files: number
  created_by: number | null
  created_at: Date
  completed_at: Date | null
}

export interface ImportFileRow {
  id: number
  import_id: number
  file_key: string
  file_size: number | null
  status: 'pending' | 'downloading' | 'imported' | 'duplicate' | 'failed' | 'skipped'
  orthanc_study_id: string | null
  sop_instance_uid: string | null
  attempts: number
  last_error: string | null
  imported_at: Date | null
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    return Buffer.from(value, 'latin1').toString('utf8').trim()
  } catch {
    return (value as string).trim()
  }
}

function extractTag(tags: Record<string, any>, tag: string): string {
  return normalizeText(tags[tag]?.Value ?? '')
}

function extractInt(tags: Record<string, any>, tag: string): number | null {
  const v = tags[tag]?.Value?.[0]
  return typeof v === 'number' ? v : null
}

function downloadUrl(environment: ZenodoEnvironment, recordId: number, fileKey: string): string {
  return `${BASE_URL[environment]}/records/${recordId}/files/${encodeURIComponent(fileKey)}/content`
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < maxAttempts) await sleep(1000 * Math.pow(2, attempt - 1))
    }
  }
  throw lastErr
}

export interface ZenodoRecordMeta {
  doi: string | null
  version: string | null
  conceptRecordId: number | null
}

export async function fetchRecordMeta(
  recordId: number,
  environment: ZenodoEnvironment,
  token: string | null,
): Promise<ZenodoRecordMeta> {
  try {
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    await throttle(environment)
    const { data } = await axios.get(`${BASE_URL[environment]}/records/${recordId}`, {
      headers,
      timeout: parseInt(process.env.ZENODO_TIMEOUT_MS ?? '10000', 10),
    })
    return {
      doi: (data.doi as string) ?? null,
      version: (data.metadata?.version as string) ?? null,
      conceptRecordId: data.conceptrecid ? parseInt(data.conceptrecid, 10) : null,
    }
  } catch {
    return { doi: null, version: null, conceptRecordId: null }
  }
}

async function streamFileToOrthanc(
  url: string,
  token: string | null,
): Promise<{ instanceId: string; studyId: string; alreadyStored: boolean }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const download = await axios.get(url, {
    responseType: 'stream',
    headers,
    timeout: parseInt(process.env.ZENODO_UPLOAD_TIMEOUT_MS ?? '300000', 10),
  })

  const { data: orthancData } = await axios.post(
    `${ORTHANC_URL}/instances`,
    download.data,
    {
      auth: orthancAuth,
      headers: { 'Content-Type': 'application/dicom' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    },
  )

  return {
    instanceId: orthancData.ID as string,
    studyId: orthancData.ParentStudy as string,
    alreadyStored: orthancData.Status === 'AlreadyStored',
  }
}

async function fetchTags(instanceId: string): Promise<Record<string, any>> {
  try {
    const { data } = await axios.get(`${ORTHANC_URL}/instances/${instanceId}/tags`, {
      auth: orthancAuth,
    })
    return data
  } catch {
    return {}
  }
}

async function deleteOrthancInstance(instanceId: string): Promise<void> {
  await axios.delete(`${ORTHANC_URL}/instances/${instanceId}`, { auth: orthancAuth })
}

async function importSingleFile(
  fileKey: string,
  recordId: number,
  environment: ZenodoEnvironment,
  token: string | null,
  overwrite: boolean,
  meta: ZenodoRecordMeta,
): Promise<FileImportResult> {
  const url = downloadUrl(environment, recordId, fileKey)

  let instanceId: string
  let studyId: string
  let alreadyStored: boolean

  try {
    const result = await withRetry(() => streamFileToOrthanc(url, token))
    instanceId = result.instanceId
    studyId = result.studyId
    alreadyStored = result.alreadyStored
  } catch (err: unknown) {
    const orthancErr = err as any
    if (orthancErr?.response?.status === 400) {
      return { fileKey, status: 'failed', error: 'El archivo no es un DICOM válido' }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { fileKey, status: 'failed', error: message }
  }

  const tags = await fetchTags(instanceId)
  const sopInstanceUid = extractTag(tags, '0008,0018')
  const studyInstanceUid = extractTag(tags, '0020,000d')
  const patientName = extractTag(tags, '0010,0010')
  const patientId = extractTag(tags, '0010,0020')
  const studyDate = extractTag(tags, '0008,0020')
  const studyDesc = extractTag(tags, '0008,1030')
  const modality = extractTag(tags, '0008,0060').toUpperCase() || 'OTHER'
  const instanceNumber = extractInt(tags, '0020,0013')
  const rows = extractInt(tags, '0028,0010')
  const cols = extractInt(tags, '0028,0011')

  if (alreadyStored) {
    const { rows: existing } = await pool.query<{ orthanc_study_id: string }>(
      'SELECT orthanc_study_id FROM studies WHERE sop_instance_uid = $1 LIMIT 1',
      [sopInstanceUid],
    )

    if (!overwrite) {
      return {
        fileKey,
        status: 'duplicate',
        sopInstanceUid,
        existingStudyId: existing[0]?.orthanc_study_id ?? studyId,
      }
    }

    // overwrite=true: delete existing and re-upload
    try {
      await deleteOrthancInstance(instanceId)
      if (existing[0]) {
        await pool.query('DELETE FROM studies WHERE sop_instance_uid = $1', [sopInstanceUid])
      }
    } catch {
      // non-fatal: continue with re-upload attempt
    }

    try {
      const reupload = await withRetry(() => streamFileToOrthanc(url, token))
      instanceId = reupload.instanceId
      studyId = reupload.studyId
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { fileKey, status: 'failed', error: `Fallo al re-importar tras sobreescritura: ${message}` }
    }
  }

  try {
    await pool.query(
      `INSERT INTO studies
         (orthanc_study_id, orthanc_instance_id, sop_instance_uid, study_instance_uid,
          patient_name, patient_id, study_date, modality, study_description,
          instance_number, rows_count, cols_count,
          zenodo_source_record_id, zenodo_source_doi, zenodo_imported_at,
          zenodo_version, zenodo_concept_record_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)
       ON CONFLICT (sop_instance_uid) DO UPDATE SET
         orthanc_study_id          = EXCLUDED.orthanc_study_id,
         orthanc_instance_id       = EXCLUDED.orthanc_instance_id,
         study_instance_uid        = EXCLUDED.study_instance_uid,
         patient_name              = EXCLUDED.patient_name,
         patient_id                = EXCLUDED.patient_id,
         study_date                = EXCLUDED.study_date,
         modality                  = EXCLUDED.modality,
         study_description         = EXCLUDED.study_description,
         instance_number           = EXCLUDED.instance_number,
         rows_count                = EXCLUDED.rows_count,
         cols_count                = EXCLUDED.cols_count,
         zenodo_source_record_id   = EXCLUDED.zenodo_source_record_id,
         zenodo_source_doi         = EXCLUDED.zenodo_source_doi,
         zenodo_imported_at        = NOW(),
         zenodo_version            = EXCLUDED.zenodo_version,
         zenodo_concept_record_id  = EXCLUDED.zenodo_concept_record_id,
         uploaded_at               = NOW()`,
      [
        studyId, instanceId, sopInstanceUid, studyInstanceUid,
        patientName, patientId, studyDate, modality, studyDesc,
        instanceNumber, rows, cols,
        recordId, meta.doi,
        meta.version, meta.conceptRecordId,
      ],
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { fileKey, status: 'failed', error: `Error al guardar en BD: ${message}` }
  }

  return { fileKey, status: 'imported', orthancStudyId: studyId, sopInstanceUid }
}

export async function importFromZenodo(opts: ImportOptions): Promise<ImportResult> {
  const { recordId, environment, files, overwriteDuplicates = false, userId, ip } = opts

  const token = await getStoredToken(environment)
  const recordMeta = await fetchRecordMeta(recordId, environment, token)
  const sourceDoi = recordMeta.doi

  const totalSize = files.reduce((acc, f) => acc + (f.fileSize ?? 0), 0)
  const largeSizeWarning = totalSize > TEN_GB

  // Skip .zip files (not supported in this version)
  const dcmFiles = files.filter((f) => !f.fileKey.toLowerCase().endsWith('.zip'))
  const skippedZips = files.filter((f) => f.fileKey.toLowerCase().endsWith('.zip'))

  // Create import job
  const { rows: jobRows } = await pool.query<{ id: number }>(
    `INSERT INTO zenodo_imports
       (record_id, environment, source_doi, status, total_files, created_by)
     VALUES ($1,$2,$3,'in_progress',$4,$5)
     RETURNING id`,
    [recordId, environment, sourceDoi, files.length, userId],
  )
  const importId = jobRows[0].id

  await logAction({
    userId,
    action: AUDIT_ACTIONS.ZENODO_IMPORT_STARTED,
    resourceId: `${recordId}::import-${importId}`,
    ip,
  })

  // Insert file rows
  for (const f of files) {
    await pool.query(
      `INSERT INTO zenodo_import_files (import_id, file_key, file_size, status)
       VALUES ($1,$2,$3,$4)`,
      [importId, f.fileKey, f.fileSize ?? null, f.fileKey.toLowerCase().endsWith('.zip') ? 'skipped' : 'pending'],
    )
  }

  // Import each .dcm file
  const results: FileImportResult[] = []

  for (const skipped of skippedZips) {
    results.push({ fileKey: skipped.fileKey, status: 'skipped', error: 'ZIP importación no soportada en esta versión' })
  }

  for (const f of dcmFiles) {
    await pool.query(
      "UPDATE zenodo_import_files SET status='downloading', attempts=attempts+1 WHERE import_id=$1 AND file_key=$2",
      [importId, f.fileKey],
    )

    const result = await importSingleFile(f.fileKey, recordId, environment, token, overwriteDuplicates, recordMeta)
    results.push(result)

    const newStatus = result.status === 'imported' ? 'imported'
      : result.status === 'duplicate' ? 'duplicate'
      : result.status === 'failed' ? 'failed'
      : 'skipped'

    await pool.query(
      `UPDATE zenodo_import_files
       SET status=$1, orthanc_study_id=$2, sop_instance_uid=$3,
           last_error=$4, imported_at=CASE WHEN $1='imported' THEN NOW() ELSE NULL END
       WHERE import_id=$5 AND file_key=$6`,
      [newStatus, result.orthancStudyId ?? null, result.sopInstanceUid ?? null, result.error ?? null, importId, f.fileKey],
    )
  }

  const imported = results.filter((r) => r.status === 'imported').length
  const duplicates = results.filter((r) => r.status === 'duplicate').length
  const failed = results.filter((r) => r.status === 'failed').length

  const finalStatus = failed > 0 && imported === 0 ? 'failed'
    : failed > 0 || duplicates > 0 ? 'partial'
    : 'completed'

  await pool.query(
    `UPDATE zenodo_imports
     SET status=$1, imported_files=$2, duplicate_files=$3, failed_files=$4, completed_at=NOW()
     WHERE id=$5`,
    [finalStatus, imported, duplicates, failed, importId],
  )

  await logAction({
    userId,
    action: AUDIT_ACTIONS.ZENODO_IMPORT_COMPLETED,
    resourceId: `${recordId}::import-${importId}::${finalStatus}`,
    ip,
  })

  return { importId, sourceDoi, results, imported, duplicates, failed, largeSizeWarning }
}

export async function getImport(importId: number): Promise<ImportRow | null> {
  const { rows } = await pool.query<ImportRow>(
    'SELECT * FROM zenodo_imports WHERE id = $1',
    [importId],
  )
  return rows[0] ?? null
}

export async function getImportFiles(importId: number): Promise<ImportFileRow[]> {
  const { rows } = await pool.query<ImportFileRow>(
    'SELECT * FROM zenodo_import_files WHERE import_id = $1 ORDER BY id',
    [importId],
  )
  return rows
}

// Standalone logAction to avoid client dependency — mirrors audit.service internals
async function logAction(entry: { userId: number; action: string; resourceId: string; ip: string }): Promise<void> {
  await pool.query(
    'INSERT INTO audit_log (user_id, action, resource_id, "timestamp", ip) VALUES ($1,$2,$3,NOW(),$4)',
    [entry.userId, entry.action, entry.resourceId, entry.ip],
  )
}
