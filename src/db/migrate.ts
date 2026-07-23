import { pool } from "./pool";
import { migration001 } from "./migrations/001_studies";
import { migration002 } from "./migrations/002_auth";

/**
 * Ordered list of schema migrations. There is no separate migration tool or
 * tracking table — every migration is written with idempotent statements
 * (CREATE/ALTER ... IF [NOT] EXISTS), so running them all on every startup is
 * safe and cheap. To evolve the schema, add a new numbered file and append it
 * here.
 */
const migrations = [migration001, migration002];

/** Apply every migration in order. Idempotent — safe to call on each boot. */
export async function runMigrations(): Promise<void> {
  for (const migration of migrations) {
    await pool.query(migration.sql);
  }
}
