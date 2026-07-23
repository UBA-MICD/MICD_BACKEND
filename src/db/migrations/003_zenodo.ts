/**
 * Migration 003 — Zenodo integration (ZEN-01…): encrypted per-environment API
 * credentials.
 *
 * Statements are idempotent so re-running on every startup is a no-op. This
 * migration grows with the Zenodo feature set — append statements here as the
 * feature evolves on this branch.
 */
export const migration003 = {
  id: "003_zenodo",
  sql: `
    -- Zenodo credentials (ZEN-01)
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

    -- Audit trail written by shared/audit.ts. The original branch inserted
    -- into audit_log without ever creating it, so every audited action
    -- (token config/removal, publish, import) failed at runtime — this DDL
    -- fixes that.
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      action      TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON audit_log(action);

    -- Panel state (ZEN-02): token expiry hint + health check results
    ALTER TABLE zenodo_config ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

    -- Zenodo health check results (one row per environment, upserted on each check)
    CREATE TABLE IF NOT EXISTS zenodo_health (
      environment  zenodo_environment PRIMARY KEY,
      status       TEXT NOT NULL CHECK (status IN ('connected', 'error', 'unconfigured')),
      error_reason TEXT,
      last_checked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_success TIMESTAMPTZ
    );

    -- Publish to Zenodo (ZEN-05)
    -- anonymization tracking (populated by US-16)
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
    -- Zenodo publication status on the study
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_doi TEXT;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_published_at TIMESTAMPTZ;

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

    -- Import from Zenodo (ZEN-07)
    -- Zenodo import origin badge
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_source_record_id INTEGER;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_source_doi TEXT;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_imported_at TIMESTAMPTZ;
    -- Zenodo version tracking for sync
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_version TEXT;
    ALTER TABLE studies ADD COLUMN IF NOT EXISTS zenodo_concept_record_id INTEGER;

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

    -- sliding-window rate limit counter (shared across processes, ZEN-17)
    CREATE TABLE IF NOT EXISTS zenodo_api_requests (
      id           SERIAL PRIMARY KEY,
      environment  zenodo_environment NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_zenodo_api_requests_env_time
      ON zenodo_api_requests(environment, requested_at);
  `,
};
