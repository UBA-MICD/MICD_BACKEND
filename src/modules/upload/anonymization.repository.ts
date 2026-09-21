import { randomUUID } from "crypto";
import { pool } from "../../db/pool";

/**
 * Persistence for the per-study anonymization log / background-job status
 * (US-16, AC2). Keep this PHI-free: `studyRef` is an opaque Orthanc id and
 * `tagsProcessed` holds tag NAMES only — never patient values.
 */

export type AnonymizationStatus = "procesando" | "exitoso" | "fallido";

export interface AnonymizationJob {
  jobUuid: string;
  status: AnonymizationStatus;
  studyRef: string | null;
  tagsProcessed: string[] | null;
  fileCount: number | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

/** Open a new job in the `procesando` state; returns its opaque id. */
export async function createJob(fileCount: number): Promise<string> {
  const jobUuid = randomUUID();
  await pool.query(
    `INSERT INTO anonymization_jobs (job_uuid, status, file_count)
     VALUES ($1, 'procesando', $2)`,
    [jobUuid, fileCount],
  );
  return jobUuid;
}

/** Mark a job finished successfully, recording the processed tag names. */
export async function markSuccess(
  jobUuid: string,
  studyRef: string | null,
  tagsProcessed: readonly string[],
): Promise<void> {
  await pool.query(
    `UPDATE anonymization_jobs
       SET status = 'exitoso', study_ref = $2, tags_processed = $3::jsonb,
           error_message = NULL, completed_at = NOW()
     WHERE job_uuid = $1`,
    [jobUuid, studyRef, JSON.stringify(tagsProcessed)],
  );
}

/** Mark a job failed. `errorMessage` must never contain patient data. */
export async function markFailure(
  jobUuid: string,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE anonymization_jobs
       SET status = 'fallido', error_message = $2, completed_at = NOW()
     WHERE job_uuid = $1`,
    [jobUuid, errorMessage],
  );
}

/** Fetch one job's status for the explorer / upload UI to poll. */
export async function getJob(
  jobUuid: string,
): Promise<AnonymizationJob | null> {
  const { rows } = await pool.query(
    `SELECT job_uuid, status, study_ref, tags_processed, file_count,
            error_message, started_at, completed_at
       FROM anonymization_jobs
      WHERE job_uuid = $1`,
    [jobUuid],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    jobUuid: r.job_uuid,
    status: r.status,
    studyRef: r.study_ref,
    tagsProcessed: r.tags_processed,
    fileCount: r.file_count,
    errorMessage: r.error_message,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}
