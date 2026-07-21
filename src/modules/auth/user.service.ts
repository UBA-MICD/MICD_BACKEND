import { pool } from "../../db/pool";

/**
 * Minimal credential record. The password column holds a bcrypt hash; the
 * shared test/development user is seeded by migration 002 (in SQL), so there is
 * no application-side seeding here.
 */
export interface User {
  id: number;
  email: string;
  password: string;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT id, email, password FROM users WHERE email = $1",
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: number): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT id, email, password FROM users WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}
