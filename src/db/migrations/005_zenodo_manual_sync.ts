/**
 * Migration 005 — Manual on-demand sync (ZEN-11):
 * - Adds progress tracking columns to zenodo_sync_log (total_records, paused_until)
 * - Enforces at most one sync 'running' at a time via a partial unique index
 */
export const migration005 = {
  id: "005_zenodo_manual_sync",
  sql: `
    ALTER TABLE zenodo_sync_log ADD COLUMN IF NOT EXISTS total_records INTEGER;
    ALTER TABLE zenodo_sync_log ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_zenodo_sync_log_one_running
      ON zenodo_sync_log (status) WHERE status = 'running';
  `,
};
