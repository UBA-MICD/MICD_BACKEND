/**
 * Migration 008 — append-only audit_log (TK-06).
 *
 * "Logs son append-only (no modificables ni borrables, ni siquiera por
 * admin)" — enforced with a BEFORE UPDATE/DELETE trigger rather than a
 * `REVOKE`, because the app's DB role (`micd`) owns `audit_log` (it created
 * it via these migrations) and table owners bypass GRANT/REVOKE checks. A
 * trigger has no such escape hatch: every UPDATE/DELETE, from any role
 * including the app's own admin-authenticated requests, is rejected at the
 * database.
 */
export const migration008 = {
  id: "008_audit_append_only",
  sql: `
    CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only: % not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
    CREATE TRIGGER trg_audit_log_append_only
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
  `,
};
