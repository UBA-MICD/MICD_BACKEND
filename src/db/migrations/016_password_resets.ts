/**
 * Migration 016 — password reset codes (self-service "forgot password").
 *
 * Same shape and guarantees as `user_invites` (007): the one-time code is stored
 * SHA-256 **hashed**, `consumed_at` marks it used, consumption is one atomic
 * `UPDATE ... RETURNING`, codes expire (1h) and issuing a new one invalidates
 * the previous. `created_at` also drives the per-account resend cooldown.
 */
export const migration016 = {
  id: "016_password_resets",
  sql: `
    CREATE TABLE IF NOT EXISTS password_resets (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash   TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
  `,
};
