// Migration 013 — Anonymization jobs / per-study log (US-16).
//
// Tracks the anonymization of every upload as a background job. Serves two
// purposes at once:
//   - the acceptance-criterion log per study (study_ref, timestamp, tags
//     processed, status), and
//   - the source of the "procesando / exitoso / fallido" state the explorer /
//     upload UI polls while a large study is being anonymized off-request.
//
// PHI RULE: this table must NEVER hold identifiable patient data. `study_ref`
// is the Orthanc study id or a hashed UID (opaque), and `tags_processed` holds
// tag NAMES, never their values. Statements are idempotent.

export const migration013 = {
  id: "013_anonymization_log",
  sql: [
    `CREATE TABLE IF NOT EXISTS anonymization_jobs (
       id             SERIAL PRIMARY KEY,
       job_uuid       TEXT UNIQUE NOT NULL,
       study_ref      TEXT,
       status         TEXT NOT NULL DEFAULT 'procesando',
       tags_processed JSONB,
       file_count     INTEGER,
       error_message  TEXT,
       started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       completed_at   TIMESTAMPTZ
     );`,
    `CREATE INDEX IF NOT EXISTS idx_anon_jobs_job_uuid ON anonymization_jobs(job_uuid);`,
    `CREATE INDEX IF NOT EXISTS idx_anon_jobs_status   ON anonymization_jobs(status);`,
  ],
};
