import { adminSeed } from "../../config/env";
import type { MigrationStatement } from "../migrate";

/**
 * Migration 006 — RBAC roles + account lifecycle (US-21 / US-H04).
 *
 * Adds the columns that turn the flat credential store into a role-aware,
 * lifecycle-aware user table:
 *   - `role`          — admin | medico | investigador (NOT NULL, CHECK-constrained)
 *   - `status`        — active | invited | blocked | deleted (NOT NULL, CHECK)
 *   - `name`          — display name (US-H04 create form)
 *   - `last_login_at` — stamped on each successful login, shown to the admin
 *   - `password`      — made NULLABLE: an invited user has no password until they
 *                       redeem their invite.
 *
 * Every column is added with `IF NOT EXISTS` and every value is normalized
 * *before* the CHECK/NOT NULL is applied, so the migration is idempotent AND
 * survives a legacy database that already carries these columns with foreign
 * values (e.g. the marketplace/Auth0 users schema).
 *
 * Companion to the 002 landmine fix: 002 no longer drops role/status/last_login_at,
 * so the values written here persist across restarts.
 *
 * The `test@micd.local` dev/test user (seeded unconditionally by 002, including in
 * production) is forced OFF admin — it has a known password and must never be an
 * admin backdoor. The real first admin is seeded from ADMIN_EMAIL/ADMIN_PASSWORD
 * only when both are set (so CI, which leaves them unset, boots adminless).
 */

// One multi-statement DDL string (no bound parameters → simple-query protocol,
// which permits several statements separated by `;`).
const DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  -- role: add, normalize any NULL/foreign value to 'medico', then constrain.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
  UPDATE users SET role = 'medico'
    WHERE role IS NULL OR role NOT IN ('admin', 'medico', 'investigador');
  ALTER TABLE users ALTER COLUMN role SET DEFAULT 'medico';
  ALTER TABLE users ALTER COLUMN role SET NOT NULL;
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'medico', 'investigador'));

  -- status: same normalize-then-constrain.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT;
  UPDATE users SET status = 'active'
    WHERE status IS NULL OR status NOT IN ('active', 'invited', 'blocked', 'deleted');
  ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';
  ALTER TABLE users ALTER COLUMN status SET NOT NULL;
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
  ALTER TABLE users ADD CONSTRAINT users_status_check
    CHECK (status IN ('active', 'invited', 'blocked', 'deleted'));

  -- US-H04 columns (both nullable).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

  -- An invited user has no password until they redeem their invite.
  ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

  -- The known-password dev user must never be an admin backdoor.
  UPDATE users SET role = 'medico'
    WHERE email = 'test@micd.local' AND role = 'admin';
`;

/**
 * Build the ordered statements. The admin seed is appended only when both
 * ADMIN_EMAIL and ADMIN_PASSWORD are present; the password is bound as a query
 * parameter (never string-interpolated) and hashed in-database with pgcrypto,
 * matching 002's seeding style. ON CONFLICT DO NOTHING keeps it a one-time seed
 * that never overwrites an existing admin's password on later boots.
 */
export function buildRolesMigrationStatements(): MigrationStatement[] {
  const stmts: MigrationStatement[] = [DDL];
  const { email, password, name } = adminSeed;
  if (email && password) {
    stmts.push({
      text: `INSERT INTO users (email, password, role, status, name)
             VALUES ($1, crypt($2, gen_salt('bf', 12)), 'admin', 'active', $3)
             ON CONFLICT (email) DO NOTHING`,
      values: [email, password, name],
    });
  }
  return stmts;
}

export const migration006 = {
  id: "006_roles",
  // Getter so the admin-seed decision reads the environment at migration time,
  // not at module import time.
  get sql(): MigrationStatement[] {
    return buildRolesMigrationStatements();
  },
};
