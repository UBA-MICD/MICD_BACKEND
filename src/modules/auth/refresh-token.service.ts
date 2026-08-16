import { createHash } from "crypto";
import { pool } from "../../db/pool";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function storeRefreshToken(
  userId: number,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, hashToken(token), expiresAt],
  );
}

export interface RefreshTokenRow {
  id: number;
  user_id: number;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await pool.query(
    "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token)],
  );
}

/**
 * Atomically revokes a valid, unexpired refresh token and returns its row —
 * or null if it was missing/expired/already used. Combining the lookup and
 * the revoke into one UPDATE closes the race where two concurrent /refresh
 * calls with the same token could otherwise both pass a SELECT check before
 * either revoke, minting two token pairs from a single refresh token.
 */
export async function consumeRefreshToken(
  token: string,
): Promise<RefreshTokenRow | null> {
  const { rows } = await pool.query<RefreshTokenRow>(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id, user_id`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}
