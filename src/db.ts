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

    -- Users — a minimal credential store: id, email, password (bcrypt hash).
    CREATE TABLE IF NOT EXISTS users (
      id       SERIAL PRIMARY KEY,
      email    TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );

    -- Converge any database created under the earlier users schema
    -- (password_hash + role + profile columns + updated_at trigger) down to the
    -- minimal id/email/password shape. Every statement here is idempotent.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'password_hash'
      ) THEN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
        UPDATE users SET password = password_hash WHERE password IS NULL;
        ALTER TABLE users ALTER COLUMN password SET NOT NULL;
        ALTER TABLE users DROP COLUMN password_hash;
      END IF;
    END $$;
    DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
    DROP FUNCTION IF EXISTS set_updated_at();
    DROP INDEX IF EXISTS idx_users_username;
    ALTER TABLE users DROP COLUMN IF EXISTS role;
    ALTER TABLE users DROP COLUMN IF EXISTS created_at;
    ALTER TABLE users DROP COLUMN IF EXISTS username;
    ALTER TABLE users DROP COLUMN IF EXISTS full_name;
    ALTER TABLE users DROP COLUMN IF EXISTS first_name;
    ALTER TABLE users DROP COLUMN IF EXISTS last_name;
    ALTER TABLE users DROP COLUMN IF EXISTS is_active;
    ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
    ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
    ALTER TABLE users DROP COLUMN IF EXISTS updated_at;

    -- Seed the shared test/development user. pgcrypto's crypt() + gen_salt('bf')
    -- produce a bcrypt ($2a$) hash that bcryptjs verifies natively, so the
    -- credential is hashed at rest — no plaintext password is stored and no
    -- seed configuration lives in the environment.
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    INSERT INTO users (email, password)
    VALUES ('test@micd.local', crypt('testpassword', gen_salt('bf', 12)))
    ON CONFLICT (email) DO NOTHING;

    -- Refresh tokens (TK-05) — hashed at rest so a DB leak can't be replayed directly
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
  `);
}
