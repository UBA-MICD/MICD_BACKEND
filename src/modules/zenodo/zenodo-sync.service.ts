import { pool } from "../../db/pool";
import { zenodoClient } from "../../clients/zenodo.client";
import { type ZenodoEnvironment, getStoredToken } from "./zenodo.service";
import { fetchRecordMeta } from "./zenodo-import.service";
import { throttle } from "./zenodo-rate-limit.service";
import { logAction, AUDIT_ACTIONS } from "../../shared/audit";

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
  new_versions: number;
  errors: number;
  error_detail: string | null;
}

export interface SyncResult {
  logId: number;
  recordsChecked: number;
  newVersions: number;
  errors: number;
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

interface ImportedRecord {
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

async function detectNewVersion(
  record: ImportedRecord,
  token: string | null,
): Promise<boolean> {
  try {
    await throttle("production");
    const { data } = await zenodoClient.getRecord(record.record_id, token, "production");

    // Strategy 1: compare latest record ID from links.latest
    const latestUrl: string | undefined = data.links?.latest;
    if (latestUrl) {
      const match = latestUrl.match(/\/records\/(\d+)/);
      if (match) {
        const latestId = parseInt(match[1], 10);
        if (latestId !== record.record_id) return true;
      }
    }

    // Strategy 2: check metadata.version changed (stored vs current)
    if (record.version && data.metadata?.version) {
      if (data.metadata.version !== record.version) return true;
    }

    return false;
  } catch {
    throw new Error(`Zenodo no respondió para el record ${record.record_id}`);
  }
}

export async function runSync(): Promise<SyncResult> {
  // Create log entry
  const { rows: logRows } = await pool.query<{ id: number }>(
    `INSERT INTO zenodo_sync_log (started_at, status, records_checked, new_versions, errors)
     VALUES (NOW(), 'running', 0, 0, 0)
     RETURNING id`,
  );
  const logId = logRows[0].id;

  await logAction({
    userId: null,
    action: AUDIT_ACTIONS.ZENODO_SYNC_STARTED,
    resourceId: `sync-${logId}`,
    ip: "system",
  });

  let recordsChecked = 0;
  let newVersions = 0;
  let errors = 0;

  try {
    const records = await getImportedRecords();
    // Use production token (records are public, sandbox tokens won't work for production records)
    const token = await getStoredToken("production");

    for (const record of records) {
      recordsChecked++;
      try {
        const hasNew = await detectNewVersion(record, token);
        if (hasNew) {
          await pool.query(
            "UPDATE studies SET zenodo_new_version_available = TRUE WHERE zenodo_source_record_id = $1",
            [record.record_id],
          );
          newVersions++;
        }
      } catch {
        errors++;
      }
    }

    await pool.query(
      `UPDATE zenodo_sync_log
       SET status='completed', completed_at=NOW(), records_checked=$1, new_versions=$2, errors=$3
       WHERE id=$4`,
      [recordsChecked, newVersions, errors, logId],
    );
    await pool.query("UPDATE zenodo_sync_config SET last_run_at=NOW() WHERE id=1");

    await logAction({
      userId: null,
      action: AUDIT_ACTIONS.ZENODO_SYNC_COMPLETED,
      resourceId: `sync-${logId}`,
      ip: "system",
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
      userId: null,
      action: AUDIT_ACTIONS.ZENODO_SYNC_FAILED,
      resourceId: `sync-${logId}`,
      ip: "system",
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

// Exported so server.ts can call it from the cron tick
export { fetchRecordMeta };
