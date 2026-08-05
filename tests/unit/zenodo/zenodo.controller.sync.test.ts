/**
 * Unit tests for the sync-related handlers in zenodo.controller.ts.
 * The service layer is mocked — no DB or network.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { Request, Response } from "express";

jest.mock("../../../src/modules/zenodo/zenodo-sync.service", () => {
  class SyncAlreadyRunningError extends Error {}
  return {
    getSyncConfig: jest.fn(),
    setSyncConfig: jest.fn(),
    runSync: jest.fn(),
    getSyncLogs: jest.fn(),
    getSyncStatus: jest.fn(),
    isValidInterval: jest.fn(),
    SyncAlreadyRunningError,
  };
});

import { runSyncNow, getSyncStatusHandler } from "../../../src/modules/zenodo/zenodo.controller";
import * as syncService from "../../../src/modules/zenodo/zenodo-sync.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

function fakeRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as any;
  res.json = jest.fn().mockReturnValue(res) as any;
  return res;
}

function fakeReq(userId = 1): Request {
  return { user: { sub: userId, email: "test@micd.local" }, ip: "127.0.0.1" } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runSyncNow", () => {
  it("returns the sync counts on success", async () => {
    (syncService.runSync as AnyMock).mockResolvedValue({
      logId: 1,
      recordsChecked: 48,
      newVersions: 3,
      errors: 0,
    });
    const res = fakeRes();

    await runSyncNow(fakeReq(), res, jest.fn());

    expect(syncService.runSync).toHaveBeenCalledWith({ userId: 1, ip: "127.0.0.1" });
    expect(res.json).toHaveBeenCalledWith({
      log_id: 1,
      records_checked: 48,
      new_versions: 3,
      errors: 0,
    });
  });

  it("returns 409 with the current status when a sync is already running", async () => {
    (syncService.runSync as AnyMock).mockRejectedValue(new syncService.SyncAlreadyRunningError());
    (syncService.getSyncStatus as AnyMock).mockResolvedValue({ running: true, status: "running" });
    const res = fakeRes();

    await runSyncNow(fakeReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: { running: true, status: "running" } }),
    );
  });

  it("returns 500 on an unexpected error", async () => {
    (syncService.runSync as AnyMock).mockRejectedValue(new Error("boom"));
    const res = fakeRes();

    await runSyncNow(fakeReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("getSyncStatusHandler", () => {
  it("returns the current sync status", async () => {
    const status = { running: false, status: "idle" as const, logId: null };
    (syncService.getSyncStatus as AnyMock).mockResolvedValue(status);
    const res = fakeRes();

    await getSyncStatusHandler(fakeReq(), res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(status);
  });
});
