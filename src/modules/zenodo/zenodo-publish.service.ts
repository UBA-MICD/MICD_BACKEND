import { pool } from "../../db/pool";
import { zenodoClient } from "../../clients/zenodo.client";
import { orthancClient } from "../../clients/orthanc.client";
import { type ZenodoEnvironment, getStoredToken } from "./zenodo.service";
import { AUDIT_ACTIONS, logAction, logActionWithClient } from "../../shared/audit";
import { throttle, FIFTY_GB } from "./zenodo-rate-limit.service";

export interface ZenodoAuthor {
  name: string;
  affiliation?: string;
  orcid?: string;
}

export interface PublishMetadata {
  title: string;
  description: string;
  authors: ZenodoAuthor[];
  license?: string;
  keywords?: string[];
}

export interface DepositionRow {
  id: number;
  orthanc_study_id: string;
  environment: ZenodoEnvironment;
  zenodo_id: number;
  bucket_url: string;
  status: "draft" | "uploading" | "published" | "failed";
  doi: string | null;
  title: string;
  description: string | null;
  authors: ZenodoAuthor[];
  keywords: string[];
  license: string;
  created_by: number | null;
  created_at: Date;
  published_at: Date | null;
  error_message: string | null;
}

export interface FileRow {
  id: number;
  deposition_id: number;
  orthanc_instance_id: string;
  filename: string;
  file_size: number | null;
  status: "pending" | "uploading" | "completed" | "failed";
  attempts: number;
  last_error: string | null;
  uploaded_at: Date | null;
}

export class ZenodoPublishError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ZenodoPublishError";
  }
}

async function createZenodoDeposition(
  token: string,
  environment: ZenodoEnvironment,
): Promise<{ zenodoId: number; bucketUrl: string }> {
  await throttle(environment);
  const { data } = await zenodoClient.createDeposition(token, environment);
  return { zenodoId: data.id as number, bucketUrl: data.links.bucket as string };
}

async function setZenodoMetadata(
  token: string,
  environment: ZenodoEnvironment,
  zenodoId: number,
  metadata: PublishMetadata,
): Promise<void> {
  await throttle(environment);
  await zenodoClient.setDepositionMetadata(token, environment, zenodoId, {
    metadata: {
      title: metadata.title,
      description: metadata.description,
      upload_type: "dataset",
      access_right: "open",
      license: metadata.license ?? "cc-by-4.0",
      creators: metadata.authors.map((a) => ({
        name: a.name,
        ...(a.affiliation ? { affiliation: a.affiliation } : {}),
        ...(a.orcid ? { orcid: a.orcid } : {}),
      })),
      keywords: metadata.keywords ?? [],
    },
  });
}

async function uploadFileToBucket(
  token: string,
  bucketUrl: string,
  filename: string,
  data: Buffer,
  environment: ZenodoEnvironment,
): Promise<void> {
  await zenodoClient.uploadFileToBucket(token, bucketUrl, filename, data, environment);
}

async function publishZenodoDeposition(
  token: string,
  environment: ZenodoEnvironment,
  zenodoId: number,
): Promise<string> {
  await throttle(environment);
  const { data } = await zenodoClient.publishDeposition(token, environment, zenodoId);
  return data.doi as string;
}

async function fetchOrthancFile(instanceId: string): Promise<Buffer> {
  const { data } = await orthancClient.getInstanceFile(instanceId);
  return Buffer.from(data);
}

export async function getDeposition(depositionId: number): Promise<DepositionRow | null> {
  const { rows } = await pool.query<DepositionRow>(
    "SELECT * FROM zenodo_depositions WHERE id = $1",
    [depositionId],
  );
  return rows[0] ?? null;
}

export async function getDepositionFiles(depositionId: number): Promise<FileRow[]> {
  const { rows } = await pool.query<FileRow>(
    "SELECT * FROM zenodo_deposition_files WHERE deposition_id = $1 ORDER BY id",
    [depositionId],
  );
  return rows;
}

export interface PublishStudyOptions {
  orthancStudyId: string;
  environment: ZenodoEnvironment;
  metadata: PublishMetadata;
  userId: number;
  ip: string;
  forceLargeUpload?: boolean;
}

export interface PublishStudyResult {
  depositionId: number;
  doi: string;
  filesUploaded: number;
  totalBytes: number;
}

export async function publishStudy(opts: PublishStudyOptions): Promise<PublishStudyResult> {
  const { orthancStudyId, environment, metadata, userId, ip, forceLargeUpload = false } = opts;

  // Verify study exists and is anonymized
  const { rows: studyRows } = await pool.query<{
    orthanc_instance_id: string;
    anonymized_at: Date | null;
  }>(
    "SELECT orthanc_instance_id, anonymized_at FROM studies WHERE orthanc_study_id = $1",
    [orthancStudyId],
  );

  if (studyRows.length === 0) {
    throw new ZenodoPublishError("Estudio no encontrado", "study_not_found");
  }
  if (studyRows.some((r) => r.anonymized_at === null)) {
    throw new ZenodoPublishError(
      "El estudio debe estar anonimizado antes de publicar en Zenodo",
      "not_anonymized",
    );
  }

  const token = await getStoredToken(environment);
  if (token === null) {
    throw new ZenodoPublishError(
      `No hay credenciales configuradas para el entorno ${environment}`,
      "no_credentials",
    );
  }

  // Collect instance IDs and check total size
  const instanceIds = studyRows.map((r) => r.orthanc_instance_id);
  let totalSize = 0;
  const fileSizes: Map<string, number> = new Map();

  for (const instanceId of instanceIds) {
    try {
      const buf = await fetchOrthancFile(instanceId);
      fileSizes.set(instanceId, buf.length);
      totalSize += buf.length;
    } catch {
      throw new ZenodoPublishError(
        `No se pudo obtener el archivo DICOM de la instancia ${instanceId}`,
        "orthanc_unavailable",
      );
    }
  }

  if (totalSize > FIFTY_GB && !forceLargeUpload) {
    throw new ZenodoPublishError(
      `El dataset ocupa ${(totalSize / 1024 ** 3).toFixed(1)} GB, lo que supera el límite de 50 GB por depósito. Envía force_large_upload: true para continuar de todas formas.`,
      "file_too_large",
    );
  }

  // Create Zenodo deposition
  const { zenodoId, bucketUrl } = await createZenodoDeposition(token, environment);

  await setZenodoMetadata(token, environment, zenodoId, metadata);

  // Persist deposition record
  const { rows: depRows } = await pool.query<{ id: number }>(
    `INSERT INTO zenodo_depositions
       (orthanc_study_id, environment, zenodo_id, bucket_url, status,
        title, description, authors, keywords, license, created_by)
     VALUES ($1,$2,$3,$4,'uploading',$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      orthancStudyId,
      environment,
      zenodoId,
      bucketUrl,
      metadata.title,
      metadata.description,
      JSON.stringify(metadata.authors),
      metadata.keywords ?? [],
      metadata.license ?? "cc-by-4.0",
      userId,
    ],
  );
  const depositionId = depRows[0].id;

  // Insert file rows
  for (const instanceId of instanceIds) {
    await pool.query(
      `INSERT INTO zenodo_deposition_files
         (deposition_id, orthanc_instance_id, filename, file_size, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [depositionId, instanceId, `${instanceId}.dcm`, fileSizes.get(instanceId) ?? null],
    );
  }

  // Upload each file with retry
  let filesUploaded = 0;
  const { rows: fileRows } = await pool.query<FileRow>(
    "SELECT * FROM zenodo_deposition_files WHERE deposition_id = $1 ORDER BY id",
    [depositionId],
  );

  for (const fileRow of fileRows) {
    await pool.query("UPDATE zenodo_deposition_files SET status=$1 WHERE id=$2", [
      "uploading",
      fileRow.id,
    ]);
    try {
      const buf = await fetchOrthancFile(fileRow.orthanc_instance_id);
      await uploadFileToBucket(token, bucketUrl, fileRow.filename, buf, environment);
      await pool.query(
        "UPDATE zenodo_deposition_files SET status=$1, uploaded_at=NOW(), attempts=attempts+1 WHERE id=$2",
        ["completed", fileRow.id],
      );
      filesUploaded++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.query(
        "UPDATE zenodo_deposition_files SET status=$1, last_error=$2, attempts=attempts+1 WHERE id=$3",
        ["failed", message, fileRow.id],
      );
      // Mark deposition failed and audit, then rethrow
      await pool.query(
        "UPDATE zenodo_depositions SET status='failed', error_message=$1 WHERE id=$2",
        [message, depositionId],
      );
      await logAction({
        userId,
        action: AUDIT_ACTIONS.ZENODO_PUBLISH_FAILED,
        resourceId: orthancStudyId,
        ip,
        detail: { phase: "upload", file: fileRow.filename, error: message },
      });
      throw new ZenodoPublishError(
        `Fallo al subir el archivo ${fileRow.filename}: ${message}`,
        "upload_failed",
      );
    }
  }

  // Publish
  let doi: string;
  try {
    doi = await publishZenodoDeposition(token, environment, zenodoId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      "UPDATE zenodo_depositions SET status='failed', error_message=$1 WHERE id=$2",
      [message, depositionId],
    );
    await logAction({
      userId,
      action: AUDIT_ACTIONS.ZENODO_PUBLISH_FAILED,
      resourceId: orthancStudyId,
      ip,
      detail: { phase: "publish", error: message },
    });
    throw new ZenodoPublishError(`Zenodo rechazó la publicación: ${message}`, "publish_rejected");
  }

  // Persist DOI — use a transaction so deposition + studies update atomically
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE zenodo_depositions SET status='published', doi=$1, published_at=NOW() WHERE id=$2",
      [doi, depositionId],
    );
    await client.query(
      "UPDATE studies SET zenodo_doi=$1, zenodo_published_at=NOW() WHERE orthanc_study_id=$2",
      [doi, orthancStudyId],
    );
    await logActionWithClient(client, {
      userId,
      action: AUDIT_ACTIONS.ZENODO_STUDY_PUBLISHED,
      resourceId: `${orthancStudyId}::${doi}`,
      ip,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { depositionId, doi, filesUploaded, totalBytes: totalSize };
}

export async function retryFailedFiles(
  depositionId: number,
  userId: number,
  ip: string,
): Promise<{ retried: number; failed: number }> {
  const dep = await getDeposition(depositionId);
  if (!dep) throw new ZenodoPublishError("Depósito no encontrado", "deposition_not_found");
  if (dep.status === "published") {
    throw new ZenodoPublishError("El depósito ya fue publicado", "already_published");
  }

  const token = await getStoredToken(dep.environment);
  if (token === null) {
    throw new ZenodoPublishError(
      `No hay credenciales configuradas para el entorno ${dep.environment}`,
      "no_credentials",
    );
  }

  const { rows: failedFiles } = await pool.query<FileRow>(
    "SELECT * FROM zenodo_deposition_files WHERE deposition_id=$1 AND status='failed' ORDER BY id",
    [depositionId],
  );

  let retried = 0;
  let failed = 0;

  for (const fileRow of failedFiles) {
    await pool.query("UPDATE zenodo_deposition_files SET status=$1 WHERE id=$2", [
      "uploading",
      fileRow.id,
    ]);
    try {
      const buf = await fetchOrthancFile(fileRow.orthanc_instance_id);
      await uploadFileToBucket(token, dep.bucket_url, fileRow.filename, buf, dep.environment);
      await pool.query(
        "UPDATE zenodo_deposition_files SET status=$1, uploaded_at=NOW(), attempts=attempts+1 WHERE id=$2",
        ["completed", fileRow.id],
      );
      retried++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.query(
        "UPDATE zenodo_deposition_files SET status=$1, last_error=$2, attempts=attempts+1 WHERE id=$3",
        ["failed", message, fileRow.id],
      );
      failed++;
    }
  }

  // If all files are now complete, attempt to publish
  if (failed === 0) {
    const { rows: remaining } = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM zenodo_deposition_files WHERE deposition_id=$1 AND status != 'completed'",
      [depositionId],
    );
    if (parseInt(remaining[0].count, 10) === 0) {
      try {
        const doi = await publishZenodoDeposition(token, dep.environment, dep.zenodo_id);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "UPDATE zenodo_depositions SET status='published', doi=$1, published_at=NOW() WHERE id=$2",
            [doi, depositionId],
          );
          await client.query(
            "UPDATE studies SET zenodo_doi=$1, zenodo_published_at=NOW() WHERE orthanc_study_id=$2",
            [doi, dep.orthanc_study_id],
          );
          await logActionWithClient(client, {
            userId,
            action: AUDIT_ACTIONS.ZENODO_STUDY_PUBLISHED,
            resourceId: `${dep.orthanc_study_id}::${doi}`,
            ip,
          });
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await pool.query(
          "UPDATE zenodo_depositions SET status='failed', error_message=$1 WHERE id=$2",
          [message, depositionId],
        );
        await logAction({
          userId,
          action: AUDIT_ACTIONS.ZENODO_PUBLISH_FAILED,
          resourceId: dep.orthanc_study_id,
          ip,
          detail: { phase: "retry", error: message },
        });
      }
    }
  }

  return { retried, failed };
}

