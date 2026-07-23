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
  `,
};
