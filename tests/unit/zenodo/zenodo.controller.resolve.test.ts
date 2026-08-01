/**
 * Unit tests for the resolveRecord handler in zenodo.controller.ts.
 * The service layer is mocked — no DB or network.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { Request, Response } from "express";

jest.mock("../../../src/modules/zenodo/zenodo-resolve.service", () => ({
  parseZenodoInput: jest.fn(),
  resolveZenodoRecord: jest.fn(),
}));

import { resolveRecord } from "../../../src/modules/zenodo/zenodo.controller";
import * as resolveService from "../../../src/modules/zenodo/zenodo-resolve.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

function fakeRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as any;
  res.json = jest.fn().mockReturnValue(res) as any;
  return res;
}

function fakeReq(query: Record<string, string>): Request {
  return { query, user: { sub: 1, email: "test@micd.local" } } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolveRecord", () => {
  it("returns 400 without calling the service when the input doesn't parse", async () => {
    (resolveService.parseZenodoInput as AnyMock).mockReturnValue(null);
    const res = fakeRes();

    await resolveRecord(fakeReq({ input: "not a doi" }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(resolveService.resolveZenodoRecord).not.toHaveBeenCalled();
  });

  it("returns the resolved record on success", async () => {
    (resolveService.parseZenodoInput as AnyMock).mockReturnValue({
      recordId: 1234567,
      environment: "production",
    });
    const resolved = { record: { id: 1234567 }, versions: [], environment: "production" };
    (resolveService.resolveZenodoRecord as AnyMock).mockResolvedValue(resolved);
    const res = fakeRes();

    await resolveRecord(fakeReq({ input: "10.5281/zenodo.1234567" }), res, jest.fn());

    expect(resolveService.resolveZenodoRecord).toHaveBeenCalledWith(1234567, "production");
    expect(res.json).toHaveBeenCalledWith(resolved);
  });

  it("returns 404 when Zenodo doesn't have the record", async () => {
    (resolveService.parseZenodoInput as AnyMock).mockReturnValue({
      recordId: 9999999,
      environment: "production",
    });
    (resolveService.resolveZenodoRecord as AnyMock).mockRejectedValue({
      response: { status: 404 },
    });
    const res = fakeRes();

    await resolveRecord(fakeReq({ input: "10.5281/zenodo.9999999" }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 503 when Zenodo is unreachable", async () => {
    (resolveService.parseZenodoInput as AnyMock).mockReturnValue({
      recordId: 1234567,
      environment: "production",
    });
    (resolveService.resolveZenodoRecord as AnyMock).mockRejectedValue({ code: "ECONNREFUSED" });
    const res = fakeRes();

    await resolveRecord(fakeReq({ input: "10.5281/zenodo.1234567" }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
  });
});
