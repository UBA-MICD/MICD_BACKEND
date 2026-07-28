import { pool } from "../../db/pool";
import { AUDIT_ACTIONS } from "../../shared/audit";

const FAILED_ACTIONS = new Set<string>([
  AUDIT_ACTIONS.ZENODO_PUBLISH_FAILED,
  AUDIT_ACTIONS.ZENODO_SYNC_FAILED,
]);

export type ActivityResult = "success" | "error";

export interface ActivityEntry {
  id: number;
  action: string;
  resourceId: string;
  timestamp: string;
  userId: number | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
  result: ActivityResult;
}

export interface ActivityListResult {
  entries: ActivityEntry[];
  total: number;
  page: number;
  totalPages: number;
}

export interface ActivityFilters {
  action?: string | string[];
  result?: ActivityResult;
  dateFrom?: string;
  dateTo?: string;
  userId?: number;
  page?: number;
  limit?: number;
}

function toResult(action: string): ActivityResult {
  return FAILED_ACTIONS.has(action) ? "error" : "success";
}

function buildWhere(
  filters: ActivityFilters,
  params: unknown[],
): string {
  const conditions: string[] = [];

  if (filters.action) {
    const actions = Array.isArray(filters.action) ? filters.action : [filters.action];
    const placeholders = actions.map((_, i) => `$${params.length + i + 1}`).join(", ");
    actions.forEach((a) => params.push(a));
    conditions.push(actions.length === 1 ? `action = ${placeholders}` : `action IN (${placeholders})`);
  }

  if (filters.result === "error") {
    const placeholders = [...FAILED_ACTIONS]
      .map((_, i) => `$${params.length + i + 1}`)
      .join(", ");
    [...FAILED_ACTIONS].forEach((a) => params.push(a));
    conditions.push(`action IN (${placeholders})`);
  } else if (filters.result === "success") {
    const placeholders = [...FAILED_ACTIONS]
      .map((_, i) => `$${params.length + i + 1}`)
      .join(", ");
    [...FAILED_ACTIONS].forEach((a) => params.push(a));
    conditions.push(`action NOT IN (${placeholders})`);
  }

  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    conditions.push(`"timestamp" >= $${params.length}`);
  }

  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`"timestamp" <= $${params.length}`);
  }

  if (filters.userId !== undefined) {
    params.push(filters.userId);
    conditions.push(`user_id = $${params.length}`);
  }

  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

export async function listActivity(filters: ActivityFilters): Promise<ActivityListResult> {
  const limit = filters.limit ?? 50;
  const page = filters.page ?? 1;
  const offset = (page - 1) * limit;

  const countParams: unknown[] = [];
  const where = buildWhere(filters, countParams);

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM audit_log ${where}`,
    countParams,
  );
  const total = parseInt(countRows[0].count, 10);
  const totalPages = Math.ceil(total / limit);

  const queryParams: unknown[] = [];
  const whereClause = buildWhere(filters, queryParams);
  queryParams.push(limit, offset);

  const { rows } = await pool.query<{
    id: number;
    action: string;
    resource_id: string;
    timestamp: Date;
    user_id: number | null;
    ip: string | null;
    detail: Record<string, unknown> | null;
  }>(
    `SELECT id, action, resource_id, "timestamp", user_id, ip, detail
     FROM audit_log
     ${whereClause}
     ORDER BY "timestamp" DESC
     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
    queryParams,
  );

  const entries: ActivityEntry[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    resourceId: r.resource_id,
    timestamp: r.timestamp.toISOString(),
    userId: r.user_id,
    ip: r.ip,
    detail: r.detail,
    result: toResult(r.action),
  }));

  return { entries, total, page, totalPages };
}

export async function exportActivityCsv(filters: ActivityFilters): Promise<string> {
  const params: unknown[] = [];
  const where = buildWhere(filters, params);

  const { rows } = await pool.query<{
    id: number;
    action: string;
    resource_id: string;
    timestamp: Date;
    user_id: number | null;
    ip: string | null;
    detail: Record<string, unknown> | null;
  }>(
    `SELECT id, action, resource_id, "timestamp", user_id, ip, detail
     FROM audit_log
     ${where}
     ORDER BY "timestamp" DESC`,
    params,
  );

  const escape = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = "timestamp,action,result,resource_id,user_id,ip,detail";
  const lines = rows.map((r) =>
    [
      r.timestamp.toISOString(),
      r.action,
      toResult(r.action),
      r.resource_id,
      r.user_id ?? "",
      r.ip ?? "",
      r.detail ? JSON.stringify(r.detail) : "",
    ]
      .map(escape)
      .join(","),
  );

  return [header, ...lines].join("\n");
}
