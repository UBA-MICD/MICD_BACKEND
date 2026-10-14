import type { Pool, PoolClient } from "pg";
import { pool } from "../../db/pool";
import { generateInviteCode, hashInviteCode } from "./invite.service";

/**
 * Password reset codes ("forgot password"). Same scheme as invite codes: the
 * plaintext is emailed and never stored — only its SHA-256 hash lives in
 * `password_resets` — and consumption is a single atomic UPDATE so a code can
 * never be redeemed twice. Codes are short-lived (1h) because, unlike an
 * invite, they unlock an account that already holds data.
 */

/** Minimum gap between two codes for the same account (anti email-bombing). */
export const RESET_COOLDOWN_SECONDS = 60;

export interface ResetInfo {
  userId: number;
  email: string;
}

/**
 * Issue a fresh reset code for a user, invalidating any previous unconsumed one.
 * Returns null — and issues nothing — if a code was already issued within the
 * cooldown window. The user row is locked so two concurrent requests can't both
 * pass the cooldown check.
 */
export async function issueReset(userId: number): Promise<string | null> {
  const code = generateInviteCode();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const recent = await client.query(
      `SELECT 1 FROM password_resets
        WHERE user_id = $1
          AND created_at > NOW() - make_interval(secs => $2)`,
      [userId, RESET_COOLDOWN_SECONDS],
    );
    if (recent.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    await consumeAllResetsForUser(userId, client);
    await client.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [userId, hashInviteCode(code)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return code;
}

/** The account an unconsumed, unexpired code belongs to, or null. */
export async function findValidReset(code: string): Promise<ResetInfo | null> {
  const { rows } = await pool.query<{ user_id: number; email: string }>(
    `SELECT pr.user_id, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.code_hash = $1
        AND pr.consumed_at IS NULL
        AND pr.expires_at > NOW()
        AND u.status = 'active'`,
    [hashInviteCode(code)],
  );
  return rows[0] ? { userId: rows[0].user_id, email: rows[0].email } : null;
}

/**
 * Atomically consume a valid code, returning the user_id it belonged to — or
 * null if it was missing/expired/already used. One UPDATE, so two concurrent
 * redemptions can't both succeed.
 */
export async function consumeReset(code: string): Promise<number | null> {
  const { rows } = await pool.query<{ user_id: number }>(
    `UPDATE password_resets SET consumed_at = NOW()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING user_id`,
    [hashInviteCode(code)],
  );
  return rows[0]?.user_id ?? null;
}

/** Invalidate every outstanding code for a user (after a successful reset). */
export async function consumeAllResetsForUser(
  userId: number,
  client: Pool | PoolClient = pool,
): Promise<void> {
  await client.query(
    "UPDATE password_resets SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL",
    [userId],
  );
}
