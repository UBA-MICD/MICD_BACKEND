import { pool } from "../../db/pool";
import { Role } from "../../shared/roles";

/**
 * Credential + authorization record. `password` is a bcrypt hash, or NULL for
 * an invited user who has not yet redeemed their invite (such a user cannot log
 * in — callers must never pass a NULL password to bcrypt). `role` and `status`
 * drive authorization; the shared test/development user is seeded by migration
 * 002 (in SQL), so there is no application-side seeding here.
 */
export interface User {
  id: number;
  email: string;
  password: string | null;
  role: Role;
  status: string;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT id, email, password, role, status FROM users WHERE email = $1",
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: number): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT id, email, password, role, status FROM users WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/** Record a successful login time — surfaced to the admin as "last access". */
export async function stampLastLogin(id: number): Promise<void> {
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [id]);
}

/** Set a redeemed invitee's password and flip the account to active. */
export async function setPasswordAndActivate(
  id: number,
  passwordHash: string,
): Promise<void> {
  await pool.query(
    "UPDATE users SET password = $2, status = 'active' WHERE id = $1",
    [id, passwordHash],
  );
}

/** Replace an existing user's password hash (password reset). */
export async function setPassword(
  id: number,
  passwordHash: string,
): Promise<void> {
  await pool.query("UPDATE users SET password = $2 WHERE id = $1", [
    id,
    passwordHash,
  ]);
}
