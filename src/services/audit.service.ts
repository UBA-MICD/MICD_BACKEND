import type { PoolClient } from 'pg'
import { pool } from '../db'

export const AUDIT_ACTIONS = {
  ZENODO_TOKEN_CONFIGURED: 'ZENODO_TOKEN_CONFIGURED',
  ZENODO_TOKEN_REMOVED: 'ZENODO_TOKEN_REMOVED',
  ZENODO_STUDY_PUBLISHED: 'ZENODO_STUDY_PUBLISHED',
  ZENODO_PUBLISH_FAILED: 'ZENODO_PUBLISH_FAILED',
  ZENODO_IMPORT_STARTED: 'ZENODO_IMPORT_STARTED',
  ZENODO_IMPORT_COMPLETED: 'ZENODO_IMPORT_COMPLETED',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

interface AuditEntry {
  userId: number
  action: AuditAction
  resourceId: string
  ip: string
}

const INSERT_AUDIT =
  'INSERT INTO audit_log (user_id, action, resource_id, "timestamp", ip) VALUES ($1,$2,$3,NOW(),$4)'

export async function logAction({ userId, action, resourceId, ip }: AuditEntry): Promise<void> {
  await pool.query(INSERT_AUDIT, [userId, action, resourceId, ip])
}

export async function logActionWithClient(
  client: PoolClient,
  { userId, action, resourceId, ip }: AuditEntry,
): Promise<void> {
  await client.query(INSERT_AUDIT, [userId, action, resourceId, ip])
}
