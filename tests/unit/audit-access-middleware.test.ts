import { Request, Response } from "express";
import { EventEmitter } from "events";
import { pool } from "../../src/db/pool";
import { auditStudyAccess } from "../../src/middleware/audit-access.middleware";
import { AUDIT_ACTIONS } from "../../src/shared/audit";

jest.mock("../../src/db/pool", () => ({ pool: { query: jest.fn() } }));

const poolQuery = pool.query as jest.Mock;

beforeEach(() => jest.clearAllMocks());

/** A minimal res that supports res.on("finish", …) and a settable statusCode. */
function makeRes(statusCode: number): Response {
  const emitter = new EventEmitter();
  const res = emitter as unknown as Response;
  (res as any).statusCode = statusCode;
  return res;
}

function makeReq(params: Record<string, string>, user?: { sub: number }): Request {
  return { params, user, ip: "203.0.113.7" } as unknown as Request;
}

describe("auditStudyAccess", () => {
  it("logs the action once the response finishes successfully (2xx)", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ studyId: "study-1" }, { sub: 42 });
    const res = makeRes(200);
    const next = jest.fn();

    auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    (res as unknown as EventEmitter).emit("finish");
    await Promise.resolve(); // flush the fire-and-forget logAction

    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO audit_log"), [
      42,
      "STUDY_VIEWED",
      "study-1",
      "203.0.113.7",
      null,
    ]);
  });

  it("does not log on a non-2xx response (e.g. 404)", async () => {
    const req = makeReq({ studyId: "missing" }, { sub: 42 });
    const res = makeRes(404);

    auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED)(req, res, jest.fn());
    (res as unknown as EventEmitter).emit("finish");
    await Promise.resolve();

    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("falls back to resourceId 'all' when the named param is absent (list routes)", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({}, { sub: 7 });
    const res = makeRes(200);

    auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED)(req, res, jest.fn());
    (res as unknown as EventEmitter).emit("finish");
    await Promise.resolve();

    expect(poolQuery).toHaveBeenCalledWith(expect.any(String), [
      7,
      "STUDY_VIEWED",
      "all",
      "203.0.113.7",
      null,
    ]);
  });

  it("reads the study id from a custom param name (legacy :id routes)", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ id: "legacy-9" }, { sub: 3 });
    const res = makeRes(204);

    auditStudyAccess(AUDIT_ACTIONS.STUDY_DELETED, "id")(req, res, jest.fn());
    (res as unknown as EventEmitter).emit("finish");
    await Promise.resolve();

    expect(poolQuery).toHaveBeenCalledWith(expect.any(String), [
      3,
      "STUDY_DELETED",
      "legacy-9",
      "203.0.113.7",
      null,
    ]);
  });

  it("logs userId null when req.user is missing", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ studyId: "s1" });
    const res = makeRes(200);

    auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED)(req, res, jest.fn());
    (res as unknown as EventEmitter).emit("finish");
    await Promise.resolve();

    expect(poolQuery).toHaveBeenCalledWith(expect.any(String), [
      null,
      "STUDY_VIEWED",
      "s1",
      "203.0.113.7",
      null,
    ]);
  });
});
