import { Pool } from "pg";

export const pool = new Pool({
  host: process.env.DB_HOST ?? "postgres",
  port: parseInt(process.env.DB_PORT ?? "5432", 10),
  database: process.env.DB_NAME ?? "micd",
  user: process.env.DB_USER ?? "micd",
  password: process.env.DB_PASSWORD ?? "micd",
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS studies (
      id                  SERIAL PRIMARY KEY,
      orthanc_study_id    TEXT NOT NULL,
      orthanc_instance_id TEXT NOT NULL,
      sop_instance_uid    TEXT UNIQUE NOT NULL,
      study_instance_uid  TEXT,
      patient_name        TEXT,
      patient_id          TEXT,
      study_date          TEXT,
      modality            TEXT,
      study_description   TEXT,
      instance_number     INTEGER,
      rows_count          INTEGER,
      cols_count          INTEGER,
      uploaded_at         TIMESTAMPTZ DEFAULT NOW()
    );
    -- Backfill column for databases created before instance_number was tracked
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS instance_number INTEGER;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_studies_orthanc_study_id ON studies(orthanc_study_id);
    CREATE INDEX IF NOT EXISTS idx_studies_modality         ON studies(modality);
    CREATE INDEX IF NOT EXISTS idx_studies_study_date       ON studies(study_date);
    DROP INDEX IF EXISTS idx_studies_patient_name;
    CREATE INDEX IF NOT EXISTS idx_studies_patient_name_trgm ON studies USING gin (patient_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_studies_patient_id_trgm   ON studies USING gin (patient_id   gin_trgm_ops);

    -- Minimal users table (TK-05 stopgap) — just enough for role checks and audit FKs
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Audit log (TK-06 stopgap)
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      action      TEXT NOT NULL,
      resource_id TEXT,
      "timestamp" TIMESTAMPTZ DEFAULT NOW(),
      ip          TEXT
    );

    -- Zenodo credentials
    DO $$ BEGIN
      CREATE TYPE zenodo_environment AS ENUM ('sandbox', 'production');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS zenodo_config (
      id              SERIAL PRIMARY KEY,
      environment     zenodo_environment NOT NULL UNIQUE,
      token_encrypted TEXT NOT NULL,
      token_hint      VARCHAR(20) NOT NULL,
      created_by      INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE zenodo_config ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

    -- Zenodo health check results (one row per environment, upserted on each check)
    CREATE TABLE IF NOT EXISTS zenodo_health (
      environment  zenodo_environment PRIMARY KEY,
      status       TEXT NOT NULL CHECK (status IN ('connected', 'error', 'unconfigured')),
      error_reason TEXT,
      last_checked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_success TIMESTAMPTZ
    );

    -- anonymization tracking (populated by US-16)
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
    -- Zenodo publication status on the study 
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_doi TEXT;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_published_at TIMESTAMPTZ;
    -- Zenodo import origin badge
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_source_record_id INTEGER;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_source_doi TEXT;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_imported_at TIMESTAMPTZ;
    -- Zenodo version tracking for sync 
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_version TEXT;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_concept_record_id INTEGER;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_new_version_available BOOLEAN DEFAULT FALSE;

    -- sync scheduler config (singleton row, id=1)
    CREATE TABLE IF NOT EXISTS zenodo_sync_config (
      id             INTEGER PRIMARY KEY DEFAULT 1,
      interval_hours INTEGER,  -- NULL = disabled; valid: 6, 12, 24, 168
      last_run_at    TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO zenodo_sync_config (id, interval_hours)
    VALUES (1, 24)
    ON CONFLICT (id) DO NOTHING;

    -- ZEN-10: audit log of each sync run
    CREATE TABLE IF NOT EXISTS zenodo_sync_log (
      id               SERIAL PRIMARY KEY,
      started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ,
      status           TEXT CHECK (status IN ('running', 'completed', 'failed')),
      records_checked  INTEGER NOT NULL DEFAULT 0,
      new_versions     INTEGER NOT NULL DEFAULT 0,
      errors           INTEGER NOT NULL DEFAULT 0,
      error_detail     TEXT
    );

    -- deposition lifecycle (one row per publish attempt per study)
    CREATE TABLE IF NOT EXISTS zenodo_depositions (
      id               SERIAL PRIMARY KEY,
      orthanc_study_id TEXT NOT NULL,
      environment      zenodo_environment NOT NULL,
      zenodo_id        INTEGER NOT NULL,
      bucket_url       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'uploading', 'published', 'failed')),
      doi              TEXT,
      title            TEXT NOT NULL,
      description      TEXT,
      authors          JSONB NOT NULL DEFAULT '[]',
      keywords         TEXT[] NOT NULL DEFAULT '{}',
      license          VARCHAR(50) NOT NULL DEFAULT 'cc-by-4.0',
      created_by       INTEGER REFERENCES users(id),
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      published_at     TIMESTAMPTZ,
      error_message    TEXT
    );

    -- import job tracking (one row per import request)
    CREATE TABLE IF NOT EXISTS zenodo_imports (
      id             SERIAL PRIMARY KEY,
      record_id      INTEGER NOT NULL,
      environment    zenodo_environment NOT NULL,
      source_doi     TEXT,
      status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'in_progress', 'completed', 'partial', 'failed')),
      total_files    INTEGER NOT NULL DEFAULT 0,
      imported_files INTEGER NOT NULL DEFAULT 0,
      duplicate_files INTEGER NOT NULL DEFAULT 0,
      failed_files   INTEGER NOT NULL DEFAULT 0,
      created_by     INTEGER REFERENCES users(id),
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      completed_at   TIMESTAMPTZ
    );

    -- per-file status within an import job
    CREATE TABLE IF NOT EXISTS zenodo_import_files (
      id               SERIAL PRIMARY KEY,
      import_id        INTEGER NOT NULL REFERENCES zenodo_imports(id),
      file_key         TEXT NOT NULL,
      file_size        BIGINT,
      status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'downloading', 'imported', 'duplicate', 'failed', 'skipped')),
      orthanc_study_id TEXT,
      sop_instance_uid TEXT,
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      imported_at      TIMESTAMPTZ
    );

    -- per-file upload tracking within a deposition
    CREATE TABLE IF NOT EXISTS zenodo_deposition_files (
      id                  SERIAL PRIMARY KEY,
      deposition_id       INTEGER NOT NULL REFERENCES zenodo_depositions(id),
      orthanc_instance_id TEXT NOT NULL,
      filename            TEXT NOT NULL,
      file_size           BIGINT,
      status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'uploading', 'completed', 'failed')),
      attempts            INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      uploaded_at         TIMESTAMPTZ
    );
  `)
}
