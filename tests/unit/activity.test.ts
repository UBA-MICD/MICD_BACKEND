/**
 * Unit tests for the activity log service (ZEN-12).
 * Mocks the DB pool — no real database.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../src/db/pool", () => ({
  pool: { query: jest.fn() },
}));

// audit.ts re-exports AUDIT_ACTIONS without DB calls, safe to import directly
jest.mock("../../src/shared/audit", () => ({
  AUDIT_ACTIONS: {
    ZENODO_TOKEN_CONFIGURED: "ZENODO_TOKEN_CONFIGURED",
    ZENODO_TOKEN_REMOVED: "ZENODO_TOKEN_REMOVED",
    ZENODO_STUDY_PUBLISHED: "ZENODO_STUDY_PUBLISHED",
    ZENODO_PUBLISH_FAILED: "ZENODO_PUBLISH_FAILED",
    ZENODO_IMPORT_STARTED: "ZENODO_IMPORT_STARTED",
    ZENODO_IMPORT_COMPLETED: "ZENODO_IMPORT_COMPLETED",
    ZENODO_SYNC_STARTED: "ZENODO_SYNC_STARTED",
    ZENODO_SYNC_COMPLETED: "ZENODO_SYNC_COMPLETED",
    ZENODO_SYNC_FAILED: "ZENODO_SYNC_FAILED",
  },
}));

import { listActivity, exportActivityCsv } from "../../src/modules/activity/activity.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

const { pool } = jest.requireMock("../../src/db/pool") as { pool: { query: AnyMock } };

function makeRow(overrides: Partial<{
  id: number;
  action: string;
  resource_id: string;
  timestamp: Date;
  user_id: number | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
}> = {}) {
  return {
    id: 1,
    action: "ZENODO_STUDY_PUBLISHED",
    resource_id: "study-abc::10.5281/zenodo.1",
    timestamp: new Date("2025-01-15T10:00:00Z"),
    user_id: 42,
    ip: "127.0.0.1",
    detail: null,
    ...overrides,
  };
}

beforeEach(() => {
  pool.query.mockReset();
});

describe("listActivity", () => {
  it("returns paginated entries with result derived from action", async () => {
    // first call: COUNT, second call: rows
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rows: [makeRow()] });

    const result = await listActivity({ page: 1, limit: 50 });

    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe("success");
    expect(result.entries[0].action).toBe("ZENODO_STUDY_PUBLISHED");
  });

  it("marks FAILED actions as result=error", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rows: [makeRow({ action: "ZENODO_PUBLISH_FAILED" })] });

    const result = await listActivity({});
    expect(result.entries[0].result).toBe("error");
  });

  it("filters by action", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await listActivity({ action: "ZENODO_SYNC_COMPLETED" });

    // Both queries should contain the action filter
    const countSql: string = pool.query.mock.calls[0][0] as string;
    expect(countSql).toContain("action = $1");
  });

  it("filters by result=error adds IN clause for failed actions", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await listActivity({ result: "error" });

    const countSql: string = pool.query.mock.calls[0][0] as string;
    expect(countSql).toContain("action IN");
  });

  it("computes correct totalPages", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: "5" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await listActivity({ page: 2, limit: 2 });
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(2);
  });
});

describe("exportActivityCsv", () => {
  it("returns CSV with correct header and rows", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        makeRow({
          action: "ZENODO_SYNC_COMPLETED",
          detail: { recordsChecked: 5 },
        }),
      ],
    });

    const csv = await exportActivityCsv({});

    const lines = csv.split("\n");
    expect(lines[0]).toBe("timestamp,action,result,resource_id,user_id,ip,detail");
    expect(lines[1]).toContain("ZENODO_SYNC_COMPLETED");
    expect(lines[1]).toContain("success");
    expect(lines[1]).toContain("recordsChecked");
  });

  it("escapes fields containing commas", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeRow({ resource_id: "study,with,commas" })],
    });

    const csv = await exportActivityCsv({});
    expect(csv).toContain('"study,with,commas"');
  });
});
