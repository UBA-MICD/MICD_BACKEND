import { pool } from "../../db/pool";
import { zenodoClient } from "../../clients/zenodo.client";
import { type ZenodoEnvironment, getStoredToken } from "./zenodo.service";
import { fetchRecordMeta } from "./zenodo-import.service";
import { throttle, type ThrottleOptions } from "./zenodo-rate-limit.service";
import { logAction, AUDIT_ACTIONS } from "../../shared/audit";

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super("A sync is already running");
    this.name = "SyncAlreadyRunningError";
  }
}

const VALID_INTERVALS = [6, 12, 24, 168] as const;
export type SyncInterval = (typeof VALID_INTERVALS)[number];

export interface SyncConfig {
  intervalHours: SyncInterval | null;
  lastRunAt: Date | null;
  updatedAt: Date;
}

export interface SyncLogRow {
  id: number;
  started_at: Date;
  completed_at: Date | null;
  status: "running" | "completed" | "failed";
  records_checked: number;
  total_records: number | null;
  new_versions: number;
  errors: number;
  error_detail: string | null;
  paused_until: Date | null;
}

export interface SyncResult {
  logId: number;
  recordsChecked: number;
  newVersions: number;
  errors: number;
}

export interface SyncStatus {
  running: boolean;
  logId: number | null;
  status: "running" | "completed" | "failed" | "idle";
  recordsChecked: number;
  totalRecords: number | null;
  newVersions: number;
  errors: number;
  pausedUntil: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export function isValidInterval(value: unknown): value is SyncInterval {
  return typeof value === "number" && (VALID_INTERVALS as readonly number[]).includes(value);
}

export async function getSyncConfig(): Promise<SyncConfig> {
  const { rows } = await pool.query<{
    interval_hours: number | null;
    last_run_at: Date | null;
    updated_at: Date;
  }>("SELECT interval_hours, last_run_at, updated_at FROM zenodo_sync_config WHERE id = 1");

  const row = rows[0];
  return {
    intervalHours: (row?.interval_hours as SyncInterval) ?? null,
    lastRunAt: row?.last_run_at ?? null,
    updatedAt: row?.updated_at ?? new Date(),
  };
}

export async function setSyncConfig(intervalHours: SyncInterval | null): Promise<SyncConfig> {
  await pool.query(
    `INSERT INTO zenodo_sync_config (id, interval_hours, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET interval_hours = $1, updated_at = NOW()`,
    [intervalHours],
  );
  return getSyncConfig();
}

export async function shouldRunSync(): Promise<boolean> {
  const config = await getSyncConfig();
  if (config.intervalHours === null) return false;
  if (config.lastRunAt === null) return true;
  const nextRun = new Date(config.lastRunAt.getTime() + config.intervalHours * 60 * 60 * 1000);
  return new Date() >= nextRun;
}

export interface ImportedRecord {
  record_id: number;
  environment: ZenodoEnvironment;
  version: string | null;
  concept_record_id: number | null;
}

async function getImportedRecords(): Promise<ImportedRecord[]> {
  const { rows } = await pool.query<ImportedRecord>(`
    SELECT DISTINCT ON (zenodo_source_record_id, environment)
      zenodo_source_record_id   AS record_id,
      'production'::text        AS environment,
      zenodo_version            AS version,
      zenodo_concept_record_id  AS concept_record_id
    FROM studies
    WHERE zenodo_source_record_id IS NOT NULL
    ORDER BY zenodo_source_record_id, environment
  `);
  return rows;
}

export interface VersionCheckResult {
  hasNewVersion: boolean;
  latestVersion: string | null;
  latestPublishedAt: string | null;
}

export async function detectNewVersion(
  record: ImportedRecord,
  token: string | null,
  throttleOptions?: ThrottleOptions,
): Promise<VersionCheckResult> {
  try {
    await throttle(record.environment, throttleOptions);
    const { data } = await zenodoClient.getRecord(record.record_id, token, record.environment);

    let hasNewVersion = false;

    // Strategy 1: compare latest record ID from links.latest
    const latestUrl: string | undefined = data.links?.latest;
    if (latestUrl) {
      const match = latestUrl.match(/\/records\/(\d+)/);
      if (match) {
        const latestId = parseInt(match[1], 10);
        if (latestId !== record.record_id) hasNewVersion = true;
      }
    }

    // Strategy 2: check metadata.version changed (stored vs current)
    if (record.version && data.metadata?.version && data.metadata.version !== record.version) {
      hasNewVersion = true;
    }

    return {
      hasNewVersion,
      latestVersion: data.metadata?.version ?? null,
      latestPublishedAt: data.metadata?.publication_date ?? null,
    };
  } catch {
    throw new Error(`Zenodo no respondió para el record ${record.record_id}`);
  }
}

/**
 * Atomically claims the single "running" slot for a sync, backed by the
 * partial unique index on zenodo_sync_log(status) WHERE status='running'.
 * Throws SyncAlreadyRunningError if another sync (cron or manual) is in flight.
 */
async function acquireSyncLock(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO zenodo_sync_log (started_at, status, records_checked, new_versions, errors)
     VALUES (NOW(), 'running', 0, 0, 0)
     ON CONFLICT (status) WHERE status = 'running' DO NOTHING
     RETURNING id`,
  );
  if (rows.length === 0) throw new SyncAlreadyRunningError();
  return rows[0].id;
}

export async function recoverStaleSyncLocks(): Promise<void> {
  await pool.query(
    `UPDATE zenodo_sync_log
     SET status='failed', completed_at=NOW(), error_detail='Interrupted by server restart'
     WHERE status='running'`,
  );
}

export async function runSync(
  triggeredBy?: { userId: number; ip: string },
): Promise<SyncResult> {
  const logId = await acquireSyncLock();

  await logAction({
    userId: triggeredBy?.userId ?? null,
    action: AUDIT_ACTIONS.ZENODO_SYNC_STARTED,
    resourceId: `sync-${logId}`,
    ip: triggeredBy?.ip ?? "system",
  });

  let recordsChecked = 0;
  let newVersions = 0;
  let errors = 0;

  try {
    const records = await getImportedRecords();
    await pool.query("UPDATE zenodo_sync_log SET total_records=$1 WHERE id=$2", [
      records.length,
      logId,
    ]);

    // Use production token (records are public, sandbox tokens won't work for production records)
    const token = await getStoredToken("production");

    for (const record of records) {
      try {
        const check = await detectNewVersion(record, token, {
          onWait: async (_waitMs, resumesAt) => {
            await pool.query("UPDATE zenodo_sync_log SET paused_until=$1 WHERE id=$2", [
              resumesAt,
              logId,
            ]);
          },
        });
        if (check.hasNewVersion) {
          await pool.query(
            "UPDATE studies SET zenodo_new_version_available = TRUE WHERE zenodo_source_record_id = $1",
            [record.record_id],
          );
          newVersions++;
        }
      } catch {
        errors++;
      }
      recordsChecked++;
      await pool.query(
        `UPDATE zenodo_sync_log
         SET records_checked=$1, new_versions=$2, errors=$3, paused_until=NULL
         WHERE id=$4`,
        [recordsChecked, newVersions, errors, logId],
      );
    }

    await pool.query(
      `UPDATE zenodo_sync_log
       SET status='completed', completed_at=NOW(), records_checked=$1, new_versions=$2, errors=$3
       WHERE id=$4`,
      [recordsChecked, newVersions, errors, logId],
    );
    await pool.query("UPDATE zenodo_sync_config SET last_run_at=NOW() WHERE id=1");

    await logAction({
      userId: triggeredBy?.userId ?? null,
      action: AUDIT_ACTIONS.ZENODO_SYNC_COMPLETED,
      resourceId: `sync-${logId}`,
      ip: triggeredBy?.ip ?? "system",
      detail: { recordsChecked, newVersions, errors },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE zenodo_sync_log
       SET status='failed', completed_at=NOW(), records_checked=$1, new_versions=$2, errors=$3, error_detail=$4
       WHERE id=$5`,
      [recordsChecked, newVersions, errors, message, logId],
    );
    await logAction({
      userId: triggeredBy?.userId ?? null,
      action: AUDIT_ACTIONS.ZENODO_SYNC_FAILED,
      resourceId: `sync-${logId}`,
      ip: triggeredBy?.ip ?? "system",
      detail: { error: message, recordsChecked, newVersions, errors },
    });
    throw err;
  }

  return { logId, recordsChecked, newVersions, errors };
}

export async function getSyncLogs(limit = 20): Promise<SyncLogRow[]> {
  const { rows } = await pool.query<SyncLogRow>(
    "SELECT * FROM zenodo_sync_log ORDER BY started_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const { rows } = await pool.query<SyncLogRow>(
    "SELECT * FROM zenodo_sync_log ORDER BY started_at DESC LIMIT 1",
  );
  const row = rows[0];
  if (!row) {
    return {
      running: false,
      logId: null,
      status: "idle",
      recordsChecked: 0,
      totalRecords: null,
      newVersions: 0,
      errors: 0,
      pausedUntil: null,
      startedAt: null,
      completedAt: null,
    };
  }
  return {
    running: row.status === "running",
    logId: row.id,
    status: row.status,
    recordsChecked: row.records_checked,
    totalRecords: row.total_records,
    newVersions: row.new_versions,
    errors: row.errors,
    pausedUntil: row.paused_until?.toISOString() ?? null,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

// Exported so server.ts can call it from the cron tick
export { fetchRecordMeta };
