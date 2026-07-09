import { pool } from '../db'

interface AuditEntry {
  userId: number
  action: string
  resourceId: string
  ip: string
}

export async function logAction({ userId, action, resourceId, ip }: AuditEntry): Promise<void> {
  await pool.query(
    'INSERT INTO audit_log (user_id, action, resource_id, "timestamp", ip) VALUES ($1,$2,$3,NOW(),$4)',
    [userId, action, resourceId, ip],
  )
}
