/**
 * Migration 002 — authentication: the `users` credential store and
 * `refresh_tokens`.
 *
 * `users` starts from a minimal (id, email, password) core where password is a
 * bcrypt hash. The DO-block converges any database created under the earlier
 * marketplace/Auth0 users schema (password_hash + profile columns + updated_at
 * trigger) down toward this shape — every statement is idempotent. A shared
 * test/development user is seeded in SQL via pgcrypto's crypt()/gen_salt('bf'),
 * which produces a $2a$ bcrypt hash that bcryptjs verifies natively, so no
 * plaintext password is ever stored and no seed config lives in the env.
 *
 * NOTE — `role`, `status` and `last_login_at` are deliberately NOT dropped here.
 * They are owned by migration 006 (RBAC + user lifecycle). Because there is no
 * migration-tracking table and every migration runs on every startup, dropping
 * them here would wipe every assigned role/state on each boot (006 would re-add
 * them empty). 006 normalizes-then-constrains any legacy values instead.
 *
 * Refresh tokens are stored hashed (SHA-256) so a DB leak can't be replayed.
 */
export const migration002 = {
  id: "002_auth",
  sql: [
    `CREATE TABLE IF NOT EXISTS users (
      id       SERIAL PRIMARY KEY,
      email    TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS id SERIAL;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'users' AND constraint_type = 'PRIMARY KEY'
      ) THEN
        ALTER TABLE users ADD PRIMARY KEY (id);
      END IF;
    END $$;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'password_hash'
      ) THEN
        UPDATE users SET password = password_hash WHERE password IS NULL;
        ALTER TABLE users DROP COLUMN password_hash;
      END IF;
    END $$;
    DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
    DROP FUNCTION IF EXISTS set_updated_at();
    DROP INDEX IF EXISTS idx_users_username;
    ALTER TABLE users DROP COLUMN IF EXISTS auth0_id CASCADE;
    ALTER TABLE users DROP COLUMN IF EXISTS preferences;
    ALTER TABLE users DROP COLUMN IF EXISTS storage_quota;
    ALTER TABLE users DROP COLUMN IF EXISTS storage_used;
    ALTER TABLE users DROP COLUMN IF EXISTS created_at;
    ALTER TABLE users DROP COLUMN IF EXISTS username;
    ALTER TABLE users DROP COLUMN IF EXISTS full_name;
    ALTER TABLE users DROP COLUMN IF EXISTS first_name;
    ALTER TABLE users DROP COLUMN IF EXISTS last_name;
    ALTER TABLE users DROP COLUMN IF EXISTS is_active;
    ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
    ALTER TABLE users DROP COLUMN IF EXISTS updated_at;`,
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
    `INSERT INTO users (email, password)
    VALUES ('test@micd.local', crypt('testpassword', gen_salt('bf', 12)))
    ON CONFLICT (email) DO NOTHING;`,
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);`,
  ],
};
