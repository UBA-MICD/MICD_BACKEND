import type { PoolClient } from "pg";
import { pool } from "../../db/pool";
import { Role } from "../../shared/roles";
import { revokeAllRefreshTokensForUser } from "../auth/refresh-token.service";

/** A user row as surfaced to the admin panel (never includes the password). */
export interface UserRow {
  id: number;
  name: string | null;
  email: string;
  role: Role;
  status: string;
  has_password: boolean;
  last_login_at: string | null;
}

const SELECT_COLUMNS =
  "id, name, email, role, status, (password IS NOT NULL) AS has_password, last_login_at";

/** Outcome of a guarded mutation: the fresh row, or why it was refused. */
export type MutationResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: "not_found" | "last_admin" };

/** List all non-deleted users, newest first. */
export async function listUsers(): Promise<UserRow[]> {
  const { rows } = await pool.query<UserRow>(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE status <> 'deleted' ORDER BY id DESC`,
  );
  return rows;
}

/** A single user by id (including a deleted one), or null. */
export async function findUserRow(id: number): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Create an invited user: name + email + role, no password yet, status
 * 'invited'. Returns null if the email is already taken.
 */
export async function insertInvitedUser(
  name: string,
  email: string,
  role: Role,
): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (name, email, role, status, password)
     VALUES ($1, $2, $3, 'invited', NULL)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [name, email, role],
  );
  return rows[0] ?? null;
}

/**
 * Number of *effective* admins (role admin AND status active), counted with the
 * rows locked FOR UPDATE so two concurrent demotions can't both read "2" and
 * both proceed. Must run inside a transaction (a client with an open BEGIN).
 */
async function lockAndCountActiveAdmins(client: PoolClient): Promise<number> {
  const { rows } = await client.query(
    "SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE",
  );
  return rows.length;
}

/**
 * Run `body` inside a transaction. Rolls back on throw. The body receives the
 * pooled client and the current effective-admin count (already locked), so the
 * last-admin guard is race-free.
 */
async function inAdminGuardedTx(
  body: (client: PoolClient, activeAdmins: number) => Promise<MutationResult>,
): Promise<MutationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const activeAdmins = await lockAndCountActiveAdmins(client);
    const result = await body(client, activeAdmins);
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Would this change drop the last effective admin? */
function wouldRemoveLastAdmin(
  target: UserRow,
  activeAdmins: number,
): boolean {
  const targetIsEffectiveAdmin =
    target.role === "admin" && target.status === "active";
  return targetIsEffectiveAdmin && activeAdmins <= 1;
}

/** Change a user's role, refusing to demote the last effective admin. */
export async function updateRole(
  id: number,
  role: Role,
): Promise<MutationResult> {
  return inAdminGuardedTx(async (client, activeAdmins) => {
    const { rows } = await client.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const target = rows[0];
    if (!target || target.status === "deleted") {
      return { ok: false, reason: "not_found" };
    }
    if (role !== "admin" && wouldRemoveLastAdmin(target, activeAdmins)) {
      return { ok: false, reason: "last_admin" };
    }
    const { rows: updated } = await client.query<UserRow>(
      `UPDATE users SET role = $2 WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, role],
    );
    return { ok: true, user: updated[0] };
  });
}

/**
 * Set status to 'blocked' or 'active'. Blocking the last effective admin is
 * refused; blocking also revokes the user's refresh tokens.
 */
export async function updateStatus(
  id: number,
  status: "blocked" | "active",
): Promise<MutationResult> {
  return inAdminGuardedTx(async (client, activeAdmins) => {
    const { rows } = await client.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const target = rows[0];
    if (!target || target.status === "deleted") {
      return { ok: false, reason: "not_found" };
    }
    if (status === "blocked" && wouldRemoveLastAdmin(target, activeAdmins)) {
      return { ok: false, reason: "last_admin" };
    }
    const { rows: updated } = await client.query<UserRow>(
      `UPDATE users SET status = $2 WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, status],
    );
    if (status === "blocked") {
      await revokeAllRefreshTokensForUser(id, client);
    }
    return { ok: true, user: updated[0] };
  });
}

/**
 * Soft-delete: set status 'deleted' and revoke refresh tokens. Refuses to
 * delete the last effective admin. Never a hard DELETE (would orphan the audit
 * trail and zenodo_config.created_by).
 */
export async function softDeleteUser(id: number): Promise<MutationResult> {
  return inAdminGuardedTx(async (client, activeAdmins) => {
    const { rows } = await client.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const target = rows[0];
    if (!target || target.status === "deleted") {
      return { ok: false, reason: "not_found" };
    }
    if (wouldRemoveLastAdmin(target, activeAdmins)) {
      return { ok: false, reason: "last_admin" };
    }
    const { rows: updated } = await client.query<UserRow>(
      `UPDATE users SET status = 'deleted' WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id],
    );
    await revokeAllRefreshTokensForUser(id, client);
    return { ok: true, user: updated[0] };
  });
}
