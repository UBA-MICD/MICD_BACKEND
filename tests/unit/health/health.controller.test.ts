import { Request, Response } from "express";

jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn() } }));
jest.mock("../../../src/clients/orthanc.client", () => ({
  orthancClient: { getSystem: jest.fn() },
}));

import { pool } from "../../../src/db/pool";
import { orthancClient } from "../../../src/clients/orthanc.client";
import { livezHandler, readyzHandler } from "../../../src/modules/health/health.controller";

const mockQuery = pool.query as jest.Mock;
const mockGetSystem = orthancClient.getSystem as jest.Mock;

function makeRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetSystem.mockReset();
});

describe("livezHandler", () => {
  it("returns 200 ok without touching Postgres or Orthanc", async () => {
    const res = makeRes();

    await livezHandler({} as Request, res, jest.fn());

    expect(res.status).not.toHaveBeenCalled(); // default 200, no explicit status call
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockGetSystem).not.toHaveBeenCalled();
  });

  it("stays 200 even when Postgres and Orthanc are both down", async () => {
    mockQuery.mockRejectedValue(new Error("connection refused"));
    mockGetSystem.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = makeRes();

    await livezHandler({} as Request, res, jest.fn());

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
  });
});

describe("readyzHandler", () => {
  it("returns 200 with the Orthanc version when both dependencies are up", async () => {
    mockQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    mockGetSystem.mockResolvedValue({ data: { Version: "1.12.4" } });
    const res = makeRes();

    await readyzHandler({} as Request, res, jest.fn());

    expect(mockQuery).toHaveBeenCalledWith("SELECT 1");
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ status: "ok", orthanc: "1.12.4" });
  });

  it("returns 503 degraded when Postgres is down, and never calls Orthanc", async () => {
    mockQuery.mockRejectedValue(new Error("connection refused"));
    const res = makeRes();

    await readyzHandler({} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "degraded",
      error: "connection refused",
    });
    expect(mockGetSystem).not.toHaveBeenCalled();
  });

  it("returns 503 degraded when Postgres is up but Orthanc is down", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    mockGetSystem.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = makeRes();

    await readyzHandler({} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "degraded",
      error: "ECONNREFUSED",
    });
  });

  it("returns 503 degraded when both Postgres and Orthanc are down", async () => {
    mockQuery.mockRejectedValue(new Error("connection refused"));
    mockGetSystem.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = makeRes();

    await readyzHandler({} as Request, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: "degraded",
      error: "connection refused", // fails on the first awaited dependency (Postgres)
    });
  });
});
