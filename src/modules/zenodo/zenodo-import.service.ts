import { pool } from "../../db/pool";
import { zenodoClient } from "../../clients/zenodo.client";
import { orthancClient } from "../../clients/orthanc.client";
import { type ZenodoEnvironment, getStoredToken } from "./zenodo.service";
import { AUDIT_ACTIONS } from "../../shared/audit";
import { throttle } from "./zenodo-rate-limit.service";
import * as unzipper from "unzipper";
import * as path from "path";

const TEN_GB = 10 * 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED = 2 * 1024 * 1024 * 1024; // 2 GB safety limit

export interface ImportFileSpec {
  fileKey: string;
  fileSize?: number;
}

export interface ImportOptions {
  recordId: number;
  environment: ZenodoEnvironment;
  files: ImportFileSpec[];
  overwriteDuplicates?: boolean;
  userId: number;
  ip: string;
}

export type FileImportStatus = "imported" | "duplicate" | "failed" | "skipped";

export interface FileImportResult {
  fileKey: string;
  status: FileImportStatus;
  orthancStudyId?: string;
  sopInstanceUid?: string;
  existingStudyId?: string;
  error?: string;
}

export interface ImportResult {
  importId: number;
  sourceDoi: string | null;
  results: FileImportResult[];
  imported: number;
  duplicates: number;
  failed: number;
  largeSizeWarning: boolean;
}

export interface ImportRow {
  id: number;
  record_id: number;
  environment: ZenodoEnvironment;
  source_doi: string | null;
  status: "pending" | "in_progress" | "completed" | "partial" | "failed";
  total_files: number;
  imported_files: number;
  duplicate_files: number;
  failed_files: number;
  created_by: number | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface ImportFileRow {
  id: number;
  import_id: number;
  file_key: string;
  file_size: number | null;
  status: "pending" | "downloading" | "imported" | "duplicate" | "failed" | "skipped";
  orthanc_study_id: string | null;
  sop_instance_uid: string | null;
  attempts: number;
  last_error: string | null;
  imported_at: Date | null;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return Buffer.from(value, "latin1").toString("utf8").trim();
  } catch {
    return (value as string).trim();
  }
}

function extractTag(tags: Record<string, any>, tag: string): string {
  return normalizeText(tags[tag]?.Value ?? "");
}

function extractInt(tags: Record<string, any>, tag: string): number | null {
  const v = tags[tag]?.Value?.[0];
  return typeof v === "number" ? v : null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

export interface ZenodoRecordMeta {
  doi: string | null;
  version: string | null;
  conceptRecordId: number | null;
}

export async function fetchRecordMeta(
  recordId: number,
  environment: ZenodoEnvironment,
  token: string | null,
): Promise<ZenodoRecordMeta> {
  try {
    await throttle(environment);
    const { data } = await zenodoClient.getRecord(recordId, token, environment);
    return {
      doi: (data.doi as string) ?? null,
      version: (data.metadata?.version as string) ?? null,
      conceptRecordId: data.conceptrecid ? parseInt(data.conceptrecid, 10) : null,
    };
  } catch {
    return { doi: null, version: null, conceptRecordId: null };
  }
}

async function streamFileToOrthanc(
  recordId: number,
  fileKey: string,
  environment: ZenodoEnvironment,
  token: string | null,
): Promise<{ instanceId: string; studyId: string; alreadyStored: boolean }> {
  const download = await zenodoClient.downloadRecordFileStream(
    recordId,
    fileKey,
    token,
    environment,
  );

  const { data: orthancData } = await orthancClient.postInstanceStream(download.data);

  return {
    instanceId: orthancData.ID as string,
    studyId: orthancData.ParentStudy as string,
    alreadyStored: orthancData.Status === "AlreadyStored",
  };
}

async function fetchTags(instanceId: string): Promise<Record<string, any>> {
  try {
    const { data } = await orthancClient.getInstanceTags(instanceId);
    return data;
  } catch {
    return {};
  }
}

async function importSingleFile(
  fileKey: string,
  recordId: number,
  environment: ZenodoEnvironment,
  token: string | null,
  overwrite: boolean,
  meta: ZenodoRecordMeta,
): Promise<FileImportResult> {
  console.log(`[zenodo-import] importSingleFile start — file=${fileKey} record=${recordId}`);
  let instanceId: string;
  let studyId: string;
  let alreadyStored: boolean;

  try {
    const result = await withRetry(() =>
      streamFileToOrthanc(recordId, fileKey, environment, token),
    );
    instanceId = result.instanceId;
    studyId = result.studyId;
    alreadyStored = result.alreadyStored;
    console.log(`[zenodo-import] Orthanc response — instanceId=${instanceId} studyId=${studyId} alreadyStored=${alreadyStored}`);
  } catch (err: unknown) {
    const orthancErr = err as any;
    const httpStatus = orthancErr?.response?.status;
    console.error(`[zenodo-import] streamFileToOrthanc threw — httpStatus=${httpStatus}`, err);
    if (httpStatus === 400) {
      return { fileKey, status: "failed", error: "El archivo no es un DICOM válido" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { fileKey, status: "failed", error: message };
  }

  const tags = await fetchTags(instanceId);
  const sopInstanceUid = extractTag(tags, "0008,0018");
  const studyInstanceUid = extractTag(tags, "0020,000d");
  const patientName = extractTag(tags, "0010,0010");
  const patientId = extractTag(tags, "0010,0020");
  const studyDate = extractTag(tags, "0008,0020");
  const studyDesc = extractTag(tags, "0008,1030");
  const modality = extractTag(tags, "0008,0060").toUpperCase() || "OTHER";
  const instanceNumber = extractInt(tags, "0020,0013");
  const rows = extractInt(tags, "0028,0010");
  const cols = extractInt(tags, "0028,0011");
  console.log(`[zenodo-import] Tags extracted — sopUid=${sopInstanceUid} patient=${patientName} modality=${modality}`);

  if (alreadyStored) {
    console.log(`[zenodo-import] alreadyStored=true, querying studies table for sopUid=${sopInstanceUid}`);
    const { rows: existing } = await pool.query<{ orthanc_study_id: string }>(
      "SELECT orthanc_study_id FROM studies WHERE sop_instance_uid = $1 LIMIT 1",
      [sopInstanceUid],
    );
    console.log(`[zenodo-import] DB lookup result — found=${existing.length} existingStudyId=${existing[0]?.orthanc_study_id}`);

    if (!overwrite) {
      if (existing.length > 0) {
        console.log(`[zenodo-import] overwrite=false, in DB → returning duplicate`);
        return {
          fileKey,
          status: "duplicate",
          sopInstanceUid,
          existingStudyId: existing[0].orthanc_study_id,
        };
      }
      // In Orthanc but missing from DB — register it so it appears in the explorer
      console.log(`[zenodo-import] alreadyStored but not in DB → inserting to register`);
    }

    // overwrite=true: delete existing and re-upload
    try {
      await orthancClient.deleteInstance(instanceId);
      if (existing[0]) {
        await pool.query("DELETE FROM studies WHERE sop_instance_uid = $1", [sopInstanceUid]);
      }
    } catch {
      // non-fatal: continue with re-upload attempt
    }

    try {
      const reupload = await withRetry(() =>
        streamFileToOrthanc(recordId, fileKey, environment, token),
      );
      instanceId = reupload.instanceId;
      studyId = reupload.studyId;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        fileKey,
        status: "failed",
        error: `Fallo al re-importar tras sobreescritura: ${message}`,
      };
    }
  }

  console.log(`[zenodo-import] alreadyStored=false (or overwrite path) → inserting into studies`);
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
        studyId,
        instanceId,
        sopInstanceUid,
        studyInstanceUid,
        patientName,
        patientId,
        studyDate,
        modality,
        studyDesc,
        instanceNumber,
        rows,
        cols,
        recordId,
        meta.doi,
        meta.version,
        meta.conceptRecordId,
      ],
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[zenodo-import] DB insert failed — ${message}`, err);
    return { fileKey, status: "failed", error: `Error al guardar en BD: ${message}` };
  }

  console.log(`[zenodo-import] importSingleFile done → status=imported studyId=${studyId}`);
  return { fileKey, status: "imported", orthancStudyId: studyId, sopInstanceUid };
}

async function bufferEntry(entry: unzipper.Entry): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    entry.on("data", (chunk: Buffer) => chunks.push(chunk));
    entry.on("end", () => resolve(Buffer.concat(chunks)));
    entry.on("error", reject);
  });
}

async function importZipFile(
  fileKey: string,
  recordId: number,
  environment: ZenodoEnvironment,
  token: string | null,
  overwrite: boolean,
  meta: ZenodoRecordMeta,
): Promise<FileImportResult[]> {
  console.log(`[zenodo-import] importZipFile start — file=${fileKey} record=${recordId}`);

  const download = await zenodoClient.downloadRecordFileStream(recordId, fileKey, token, environment);
  const zipStream: NodeJS.ReadableStream = download.data;

  // Collect all DCM entries first, draining non-DCM ones immediately,
  // then process sequentially to avoid backpressure / async-in-event-handler issues.
  const dcmEntries: { baseName: string; buffer: Buffer }[] = [];
  let totalUncompressed = 0;
  let limitExceeded = false;

  await new Promise<void>((resolve, reject) => {
    const parser = zipStream.pipe(unzipper.Parse({ forceStream: true }));

    parser.on("entry", (entry: unzipper.Entry) => {
      const entryPath: string = entry.path;
      const baseName = path.basename(entryPath);
      const isDcm = baseName.toLowerCase().endsWith(".dcm");

      if (!isDcm || entryPath.includes("..") || limitExceeded) {
        if (!isDcm) console.log(`[zenodo-import] ZIP: skipping entry "${entryPath}"`);
        entry.autodrain();
        return;
      }

      // Pause the parser while buffering this entry so we don't lose data
      parser.pause();
      bufferEntry(entry)
        .then((buf) => {
          totalUncompressed += buf.byteLength;
          if (totalUncompressed > MAX_UNCOMPRESSED) {
            limitExceeded = true;
            console.warn(`[zenodo-import] ZIP: 2 GB limit exceeded, stopping`);
          } else {
            console.log(`[zenodo-import] ZIP: buffered "${baseName}" (${buf.byteLength} bytes)`);
            dcmEntries.push({ baseName, buffer: buf });
          }
          parser.resume();
        })
        .catch((err) => {
          console.error(`[zenodo-import] ZIP: error buffering "${baseName}":`, err);
          parser.resume();
        });
    });

    parser.on("finish", resolve);
    parser.on("error", reject);
  });

  console.log(`[zenodo-import] ZIP: ${dcmEntries.length} DCM entries buffered, processing…`);

  const results: FileImportResult[] = [];

  if (limitExceeded) {
    results.push({ fileKey, status: "failed", error: "ZIP supera el límite de 2 GB descomprimido" });
    return results;
  }

  for (const { baseName, buffer } of dcmEntries) {
    try {
      const { data: orthancData } = await orthancClient.postInstance(buffer);
      const instanceId: string = orthancData.ID;
      const studyId: string = orthancData.ParentStudy;
      const alreadyStored: boolean = orthancData.Status === "AlreadyStored";

      console.log(`[zenodo-import] ZIP entry "${baseName}" → Orthanc instanceId=${instanceId} alreadyStored=${alreadyStored}`);

      const tags = await fetchTags(instanceId);
      const sopInstanceUid = extractTag(tags, "0008,0018");
      const studyInstanceUid = extractTag(tags, "0020,000d");
      const patientName = extractTag(tags, "0010,0010");
      const patientId = extractTag(tags, "0010,0020");
      const studyDate = extractTag(tags, "0008,0020");
      const studyDesc = extractTag(tags, "0008,1030");
      const modality = extractTag(tags, "0008,0060").toUpperCase() || "OTHER";
      const instanceNumber = extractInt(tags, "0020,0013");
      const rows = extractInt(tags, "0028,0010");
      const cols = extractInt(tags, "0028,0011");

      if (alreadyStored) {
        const { rows: existing } = await pool.query<{ orthanc_study_id: string }>(
          "SELECT orthanc_study_id FROM studies WHERE sop_instance_uid = $1 LIMIT 1",
          [sopInstanceUid],
        );
        if (!overwrite && existing.length > 0) {
          results.push({ fileKey: baseName, status: "duplicate", sopInstanceUid, existingStudyId: existing[0].orthanc_study_id });
          continue;
        }
      }

      await pool.query(
        `INSERT INTO studies
           (orthanc_study_id, orthanc_instance_id, sop_instance_uid, study_instance_uid,
            patient_name, patient_id, study_date, modality, study_description,
            instance_number, rows_count, cols_count,
            zenodo_source_record_id, zenodo_source_doi, zenodo_imported_at,
            zenodo_version, zenodo_concept_record_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)
         ON CONFLICT (sop_instance_uid) DO UPDATE SET
           orthanc_study_id = EXCLUDED.orthanc_study_id,
           orthanc_instance_id = EXCLUDED.orthanc_instance_id,
           study_instance_uid = EXCLUDED.study_instance_uid,
           patient_name = EXCLUDED.patient_name,
           patient_id = EXCLUDED.patient_id,
           study_date = EXCLUDED.study_date,
           modality = EXCLUDED.modality,
           study_description = EXCLUDED.study_description,
           instance_number = EXCLUDED.instance_number,
           rows_count = EXCLUDED.rows_count,
           cols_count = EXCLUDED.cols_count,
           zenodo_source_record_id = EXCLUDED.zenodo_source_record_id,
           zenodo_source_doi = EXCLUDED.zenodo_source_doi,
           zenodo_imported_at = NOW(),
           zenodo_version = EXCLUDED.zenodo_version,
           zenodo_concept_record_id = EXCLUDED.zenodo_concept_record_id,
           uploaded_at = NOW()`,
        [studyId, instanceId, sopInstanceUid, studyInstanceUid, patientName, patientId,
         studyDate, modality, studyDesc, instanceNumber, rows, cols,
         recordId, meta.doi, meta.version, meta.conceptRecordId],
      );
      results.push({ fileKey: baseName, status: "imported", orthancStudyId: studyId, sopInstanceUid });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[zenodo-import] ZIP entry "${baseName}" failed:`, message);
      results.push({ fileKey: baseName, status: "failed", error: message });
    }
  }

  console.log(`[zenodo-import] importZipFile done — imported=${results.filter(r=>r.status==="imported").length} duplicate=${results.filter(r=>r.status==="duplicate").length} failed=${results.filter(r=>r.status==="failed").length}`);
  return results;
}

export async function importFromZenodo(opts: ImportOptions): Promise<ImportResult> {
  const { recordId, environment, files, overwriteDuplicates = false, userId, ip } = opts;

  const token = await getStoredToken(environment);
  const recordMeta = await fetchRecordMeta(recordId, environment, token);
  const sourceDoi = recordMeta.doi;

  const totalSize = files.reduce((acc, f) => acc + (f.fileSize ?? 0), 0);
  const largeSizeWarning = totalSize > TEN_GB;

  const dcmFiles = files.filter((f) => !f.fileKey.toLowerCase().endsWith(".zip"));
  const zipFiles = files.filter((f) => f.fileKey.toLowerCase().endsWith(".zip"));

  // Create import job
  const { rows: jobRows } = await pool.query<{ id: number }>(
    `INSERT INTO zenodo_imports
       (record_id, environment, source_doi, status, total_files, created_by)
     VALUES ($1,$2,$3,'in_progress',$4,$5)
     RETURNING id`,
    [recordId, environment, sourceDoi, files.length, userId],
  );
  const importId = jobRows[0].id;

  await logAction({
    userId,
    action: AUDIT_ACTIONS.ZENODO_IMPORT_STARTED,
    resourceId: `${recordId}::import-${importId}`,
    ip,
  });

  // Insert file rows
  for (const f of files) {
    await pool.query(
      `INSERT INTO zenodo_import_files (import_id, file_key, file_size, status)
       VALUES ($1,$2,$3,'pending')`,
      [importId, f.fileKey, f.fileSize ?? null],
    );
  }

  const results: FileImportResult[] = [];

  // Process .dcm files directly
  for (const f of dcmFiles) {
    await pool.query(
      "UPDATE zenodo_import_files SET status='downloading', attempts=attempts+1 WHERE import_id=$1 AND file_key=$2",
      [importId, f.fileKey],
    );

    const result = await importSingleFile(
      f.fileKey,
      recordId,
      environment,
      token,
      overwriteDuplicates,
      recordMeta,
    );
    results.push(result);

    const newStatus = result.status === "imported" ? "imported"
      : result.status === "duplicate" ? "duplicate"
      : result.status === "failed" ? "failed"
      : "skipped";

    await pool.query(
      `UPDATE zenodo_import_files
       SET status=$1, orthanc_study_id=$2, sop_instance_uid=$3,
           last_error=$4, imported_at=CASE WHEN $1='imported' THEN NOW() ELSE NULL END
       WHERE import_id=$5 AND file_key=$6`,
      [newStatus, result.orthancStudyId ?? null, result.sopInstanceUid ?? null,
       result.error ?? null, importId, f.fileKey],
    );
  }

  // Process .zip files — stream, extract, import each .dcm inside
  for (const f of zipFiles) {
    await pool.query(
      "UPDATE zenodo_import_files SET status='downloading', attempts=attempts+1 WHERE import_id=$1 AND file_key=$2",
      [importId, f.fileKey],
    );
    try {
      const zipResults = await importZipFile(f.fileKey, recordId, environment, token, overwriteDuplicates, recordMeta);
      results.push(...zipResults);
      const anyImported = zipResults.some((r) => r.status === "imported");
      const anyFailed = zipResults.some((r) => r.status === "failed");
      const zipStatus = anyImported ? "imported" : anyFailed ? "failed" : "duplicate";
      await pool.query(
        `UPDATE zenodo_import_files SET status=$1, imported_at=CASE WHEN $1='imported' THEN NOW() ELSE NULL END
         WHERE import_id=$2 AND file_key=$3`,
        [zipStatus, importId, f.fileKey],
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[zenodo-import] ZIP "${f.fileKey}" extraction failed:`, message);
      results.push({ fileKey: f.fileKey, status: "failed", error: message });
      await pool.query(
        "UPDATE zenodo_import_files SET status='failed', last_error=$1 WHERE import_id=$2 AND file_key=$3",
        [message, importId, f.fileKey],
      );
    }
  }

  const imported = results.filter((r) => r.status === "imported").length;
  const duplicates = results.filter((r) => r.status === "duplicate").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const finalStatus =
    failed > 0 && imported === 0
      ? "failed"
      : failed > 0 || duplicates > 0
        ? "partial"
        : "completed";

  await pool.query(
    `UPDATE zenodo_imports
     SET status=$1, imported_files=$2, duplicate_files=$3, failed_files=$4, completed_at=NOW()
     WHERE id=$5`,
    [finalStatus, imported, duplicates, failed, importId],
  );

  await logAction({
    userId,
    action: AUDIT_ACTIONS.ZENODO_IMPORT_COMPLETED,
    resourceId: `${recordId}::import-${importId}::${finalStatus}`,
    ip,
  });

  return { importId, sourceDoi, results, imported, duplicates, failed, largeSizeWarning };
}

export async function getImport(importId: number): Promise<ImportRow | null> {
  const { rows } = await pool.query<ImportRow>("SELECT * FROM zenodo_imports WHERE id = $1", [
    importId,
  ]);
  return rows[0] ?? null;
}

export async function getImportFiles(importId: number): Promise<ImportFileRow[]> {
  const { rows } = await pool.query<ImportFileRow>(
    "SELECT * FROM zenodo_import_files WHERE import_id = $1 ORDER BY id",
    [importId],
  );
  return rows;
}

// Standalone logAction to avoid client dependency — mirrors shared/audit internals
async function logAction(entry: {
  userId: number;
  action: string;
  resourceId: string;
  ip: string;
}): Promise<void> {
  await pool.query(
    'INSERT INTO audit_log (user_id, action, resource_id, "timestamp", ip) VALUES ($1,$2,$3,NOW(),$4)',
    [entry.userId, entry.action, entry.resourceId, entry.ip],
  );
}
