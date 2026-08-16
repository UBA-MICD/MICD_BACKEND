/**
 * Migration 002 — authentication: the `users` credential store and
 * `refresh_tokens`.
 *
 * `users` is deliberately minimal: (id, email, password) where password is a
 * bcrypt hash. The DO-block converges any database created under the earlier
 * users schema (password_hash + role + profile columns + updated_at trigger)
 * down to this minimal shape — every statement is idempotent. A shared
 * test/development user is seeded in SQL via pgcrypto's crypt()/gen_salt('bf'),
 * which produces a $2a$ bcrypt hash that bcryptjs verifies natively, so no
 * plaintext password is ever stored and no seed config lives in the env.
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
    ALTER TABLE users DROP COLUMN IF EXISTS role;
    ALTER TABLE users DROP COLUMN IF EXISTS auth0_id CASCADE;
    ALTER TABLE users DROP COLUMN IF EXISTS status;
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
    ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
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
