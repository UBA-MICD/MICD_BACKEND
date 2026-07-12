import { pool } from "../db";
import { hashPassword } from "./password.service";

export interface User {
  id: number;
  email: string;
  password_hash: string;
  role: "admin" | "user";
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT id, email, password_hash, role FROM users WHERE email = $1",
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: number): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT id, email, password_hash, role FROM users WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/** Idempotent: no-op if a user with ADMIN_EMAIL already exists. */
export async function seedAdminUser(): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? "admin@micd.local";
  const password = process.env.ADMIN_PASSWORD ?? "change-me-admin-password";

  const existing = await findUserByEmail(email);
  if (existing) return;

  const passwordHash = await hashPassword(password);
  await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')",
    [email, passwordHash],
  );
}
