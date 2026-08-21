/**
 * Migration 007 — user invites (US-H04 create-user).
 *
 * An admin creates a password-less `invited` user; that user redeems a one-time
 * code (emailed to them) to set their own password and activate the account.
 *
 * Shaped like `refresh_tokens`: the code is stored SHA-256 **hashed** (never in
 * clear), so a DB leak yields no redeemable codes; `consumed_at` plays the role
 * of `revoked_at`. Consumption is a single atomic `UPDATE ... RETURNING` to
 * close the reuse race. Codes expire (48h) and issuing a new one invalidates the
 * previous. ON DELETE CASCADE so a hard-deleted user (should one ever occur)
 * doesn't orphan invites — user deletion is soft, but the FK stays honest.
 */
export const migration007 = {
  id: "007_user_invites",
  sql: `
    CREATE TABLE IF NOT EXISTS user_invites (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash   TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_invites_user_id ON user_invites(user_id);
  `,
};
