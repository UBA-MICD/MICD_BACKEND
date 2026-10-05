import { pool } from "./pool";
import { migration001 } from "./migrations/001_studies";
import { migration002 } from "./migrations/002_auth";
import { migration003 } from "./migrations/003_zenodo";
import { migration004 } from "./migrations/004_activity_log";
import { migration005 } from "./migrations/005_zenodo_manual_sync";
import { migration006 } from "./migrations/006_roles";
import { migration007 } from "./migrations/007_user_invites";
import { migration008 } from "./migrations/008_audit_append_only";
import { migration009 } from "./migrations/009_study_description_index";
import { migration010 } from "./migrations/010_validations";
import { migration011 } from "./migrations/011_ml_predictions";
import { migration012 } from "./migrations/012_study_metadata";
import { migration013 } from "./migrations/013_segmentations";
import { migration014 } from "./migrations/014_pathologies";
import { migration015 } from "./migrations/015_anonymization_review";

/**
 * A single migration statement. Either raw SQL (may contain several
 * `;`-separated statements, run over the simple-query protocol), or a
 * parameterized `{ text, values }` — used when a value must be bound rather
 * than interpolated (e.g. a seeded password). Parameterized statements go over
 * the extended-query protocol and therefore must be a single statement.
 */
export type MigrationStatement = string | { text: string; values: unknown[] };

interface Migration {
  id: string;
  sql: MigrationStatement | MigrationStatement[];
}

/**
 * Ordered list of schema migrations. There is no separate migration tool or
 * tracking table — every migration is written with idempotent statements
 * (CREATE/ALTER ... IF [NOT] EXISTS), so running them all on every startup is
 * safe and cheap. To evolve the schema, add a new numbered file and append it
 * here.
 */
const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
];

/** Apply every migration in order. Idempotent — safe to call on each boot. */
export async function runMigrations(): Promise<void> {
  for (const migration of migrations) {
    const stmts = Array.isArray(migration.sql)
      ? migration.sql
      : [migration.sql];
    for (const stmt of stmts) {
      if (typeof stmt === "string") {
        await pool.query(stmt);
      } else {
        await pool.query(stmt.text, stmt.values);
      }
    }
  }
}
