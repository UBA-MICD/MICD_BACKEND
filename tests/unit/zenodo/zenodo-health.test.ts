import axios from "axios";
import {
  checkHealth,
  checkAllEnvironments,
} from "../../../src/modules/zenodo/zenodo.service";

jest.mock("axios");
jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn() } }));
jest.mock("../../../src/shared/encryption", () => ({
  decrypt: jest.fn((v: string) => v),
  encrypt: jest.fn((v: string) => v),
  assertEncryptionKeyConfigured: jest.fn(),
}));

import { pool } from "../../../src/db/pool";

const mockedAxiosGet = (axios as jest.Mocked<typeof axios>).get;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedQuery = pool.query as jest.MockedFunction<any>;

const makeHealthRow = (overrides = {}) => ({
  environment: "sandbox",
  status: "connected",
  error_reason: null,
  last_checked: new Date(),
  last_success: new Date(),
  ...overrides,
});

describe("checkHealth", () => {
  afterEach(() => jest.resetAllMocks());

  it("upserts unconfigured when no token is stored", async () => {
    // getStoredToken → empty rows
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    // upsert unconfigured
    const row = makeHealthRow({ status: "unconfigured", last_success: null });
    mockedQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await checkHealth("sandbox");

    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(result.status).toBe("unconfigured");
    expect(result.last_success).toBeNull();
  });

  it("upserts connected when token is valid", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ token_encrypted: "enc-token" }] });
    mockedAxiosGet.mockResolvedValueOnce({ status: 200, data: {} });
    const row = makeHealthRow({ status: "connected" });
    mockedQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await checkHealth("sandbox");

    expect(result.status).toBe("connected");
    expect(result.last_success).not.toBeNull();
  });

  it("upserts error and preserves last_success when token is invalid", async () => {
    const previousSuccess = new Date("2026-07-01T00:00:00Z");
    mockedQuery.mockResolvedValueOnce({ rows: [{ token_encrypted: "enc-token" }] });
    mockedAxiosGet.mockRejectedValueOnce({ response: { status: 401 } });
    const row = makeHealthRow({
      status: "error",
      error_reason: "invalid_token",
      last_success: previousSuccess,
    });
    mockedQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await checkHealth("sandbox");

    expect(result.status).toBe("error");
    expect(result.error_reason).toBe("invalid_token");
    expect(result.last_success).toEqual(previousSuccess);
  });

  it("upserts error with reason timeout on Zenodo timeout", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ token_encrypted: "enc-token" }] });
    mockedAxiosGet.mockRejectedValueOnce({ code: "ECONNABORTED", message: "timeout" });
    const row = makeHealthRow({ status: "error", error_reason: "timeout", last_success: null });
    mockedQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await checkHealth("production");

    expect(result.status).toBe("error");
    expect(result.error_reason).toBe("timeout");
  });
});

describe("checkAllEnvironments", () => {
  afterEach(() => jest.resetAllMocks());

  it("checks both sandbox and production", async () => {
    // each environment: getStoredToken query + upsert query
    const row = makeHealthRow({ status: "unconfigured", last_success: null });
    mockedQuery.mockResolvedValue({ rows: [row] });
    // getStoredToken returns empty for both
    mockedQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });

    await checkAllEnvironments();

    // 2 getStoredToken calls + 2 upsert calls = 4 total
    expect(mockedQuery).toHaveBeenCalledTimes(4);
  });
});
