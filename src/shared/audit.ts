import type { PoolClient } from "pg";
import { pool } from "../db/pool";

/**
 * Append-only audit trail of security-relevant actions (Zenodo credential
 * changes, publications, imports). Writes go to the `audit_log` table; the
 * `WithClient` variant lets callers include the entry in an open transaction.
 */
export const AUDIT_ACTIONS = {
  ZENODO_TOKEN_CONFIGURED: "ZENODO_TOKEN_CONFIGURED",
  ZENODO_TOKEN_REMOVED: "ZENODO_TOKEN_REMOVED",
  ZENODO_STUDY_PUBLISHED: "ZENODO_STUDY_PUBLISHED",
  ZENODO_PUBLISH_FAILED: "ZENODO_PUBLISH_FAILED",
  ZENODO_IMPORT_STARTED: "ZENODO_IMPORT_STARTED",
  ZENODO_IMPORT_COMPLETED: "ZENODO_IMPORT_COMPLETED",
  ZENODO_SYNC_STARTED: "ZENODO_SYNC_STARTED",
  ZENODO_SYNC_COMPLETED: "ZENODO_SYNC_COMPLETED",
  ZENODO_SYNC_FAILED: "ZENODO_SYNC_FAILED",
  ZENODO_MANUAL_CHECK: "ZENODO_MANUAL_CHECK",
  // User lifecycle (US-H04)
  USER_CREATED: "USER_CREATED",
  USER_ROLE_CHANGED: "USER_ROLE_CHANGED",
  USER_BLOCKED: "USER_BLOCKED",
  USER_UNBLOCKED: "USER_UNBLOCKED",
  USER_DELETED: "USER_DELETED",
  INVITE_SENT: "INVITE_SENT",
  INVITE_REDEEMED: "INVITE_REDEEMED",
  // Study access (TK-06)
  STUDY_VIEWED: "STUDY_VIEWED",
  STUDY_UPLOADED: "STUDY_UPLOADED",
  STUDY_DOWNLOADED: "STUDY_DOWNLOADED",
  STUDY_DELETED: "STUDY_DELETED",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

interface AuditEntry {
  userId: number | null;
  action: AuditAction;
  resourceId: string;
  ip: string;
  detail?: Record<string, unknown>;
}

const INSERT_AUDIT =
  'INSERT INTO audit_log (user_id, action, resource_id, "timestamp", ip, detail) VALUES ($1,$2,$3,NOW(),$4,$5)';

export async function logAction({
  userId,
  action,
  resourceId,
  ip,
  detail,
}: AuditEntry): Promise<void> {
  await pool.query(INSERT_AUDIT, [
    userId,
    action,
    resourceId,
    ip,
    detail ? JSON.stringify(detail) : null,
  ]);
}

export async function logActionWithClient(
  client: PoolClient,
  { userId, action, resourceId, ip, detail }: AuditEntry,
): Promise<void> {
  await client.query(INSERT_AUDIT, [
    userId,
    action,
    resourceId,
    ip,
    detail ? JSON.stringify(detail) : null,
  ]);
}
