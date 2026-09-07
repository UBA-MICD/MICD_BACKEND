import { createHash, randomBytes } from "crypto";
import { pool } from "../../db/pool";

/**
 * Invite codes for the create-user flow. The plaintext code is emailed to the
 * new user and never stored — only its SHA-256 hash lives in `user_invites`,
 * mirroring how refresh tokens are handled. Consumption is a single atomic
 * UPDATE so a code can never be redeemed twice (reuse race closed).
 */

// A 24-byte random code, URL-safe so it drops cleanly into an ?invite= link.
export function generateInviteCode(): string {
  return randomBytes(24).toString("base64url");
}

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export interface InviteInfo {
  userId: number;
  email: string;
}

/**
 * Issue a fresh invite for a user, invalidating any previous unconsumed one
 * (so only the latest link works). Returns the plaintext code to email.
 */
export async function issueInvite(userId: number): Promise<string> {
  const code = generateInviteCode();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE user_invites SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId],
    );
    await client.query(
      `INSERT INTO user_invites (user_id, code_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '48 hours')`,
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

/** The email an unconsumed, unexpired code belongs to, or null. */
export async function findValidInvite(code: string): Promise<InviteInfo | null> {
  const { rows } = await pool.query<{ user_id: number; email: string }>(
    `SELECT ui.user_id, u.email
       FROM user_invites ui
       JOIN users u ON u.id = ui.user_id
      WHERE ui.code_hash = $1
        AND ui.consumed_at IS NULL
        AND ui.expires_at > NOW()`,
    [hashInviteCode(code)],
  );
  return rows[0] ? { userId: rows[0].user_id, email: rows[0].email } : null;
}

/**
 * Atomically consume a valid code, returning the user_id it belonged to — or
 * null if it was missing/expired/already used. One UPDATE, no read-then-write
 * gap, so two concurrent redemptions can't both succeed.
 */
export async function consumeInvite(code: string): Promise<number | null> {
  const { rows } = await pool.query<{ user_id: number }>(
    `UPDATE user_invites SET consumed_at = NOW()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING user_id`,
    [hashInviteCode(code)],
  );
  return rows[0]?.user_id ?? null;
}
