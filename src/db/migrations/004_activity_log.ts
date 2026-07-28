/**
 * Migration 004 — Activity log enhancements (ZEN-12):
 * - Adds JSONB detail column to audit_log for structured error/response data
 */
export const migration004 = {
  id: "004_activity_log",
  sql: `
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detail JSONB;
  `,
};
