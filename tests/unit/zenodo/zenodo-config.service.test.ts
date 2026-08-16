import { pool } from "../../../src/db/pool";
import {
  getStoredToken,
  configureZenodoToken,
  removeZenodoConfig,
  getConfigStatus,
  getHealthStatus,
  ZenodoTokenError,
} from "../../../src/modules/zenodo/zenodo.service";

jest.mock("axios");
jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock("../../../src/shared/encryption", () => ({
  encrypt: jest.fn((v: string) => `enc(${v})`),
  decrypt: jest.fn((v: string) => `dec(${v})`),
}));
jest.mock("../../../src/shared/audit", () => ({
  AUDIT_ACTIONS: {
    ZENODO_TOKEN_CONFIGURED: "ZENODO_TOKEN_CONFIGURED",
    ZENODO_TOKEN_REMOVED: "ZENODO_TOKEN_REMOVED",
  },
  logActionWithClient: jest.fn(),
}));

import axios from "axios";
import { logActionWithClient } from "../../../src/shared/audit";

const mockedAxios = axios as jest.Mocked<typeof axios>;
const poolQuery = pool.query as jest.Mock;
const poolConnect = pool.connect as jest.Mock;
const mockedLogWithClient = logActionWithClient as jest.Mock;

function makeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe("getStoredToken", () => {
  it("returns the decrypted token when a row exists", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ token_encrypted: "ciphertext" }] });
    await expect(getStoredToken("sandbox")).resolves.toBe("dec(ciphertext)");
  });

  it("returns null when no config row exists", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getStoredToken("production")).resolves.toBeNull();
  });
});

describe("configureZenodoToken", () => {
  it("validates, encrypts, upserts and audits in one transaction", async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: {} } as any); // validateToken
    const client = makeClient();
    poolConnect.mockResolvedValue(client as any);

    const result = await configureZenodoToken("secret-token-abcd", "sandbox", 7, "1.2.3.4");

    expect(result.hint).toBe("xxxx...abcd");
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("INSERT INTO zenodo_config");
    expect(client.query.mock.calls[1][1]).toEqual([
      "sandbox",
      "enc(secret-token-abcd)",
      "xxxx...abcd",
      7,
    ]);
    expect(mockedLogWithClient).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ action: "ZENODO_TOKEN_CONFIGURED", resourceId: "sandbox" }),
    );
    expect(sqls).toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("masks very short tokens as plain xxxx", async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: {} } as any);
    const client = makeClient();
    poolConnect.mockResolvedValue(client as any);

    const result = await configureZenodoToken("abc", "production", 1, "");
    expect(result.hint).toBe("xxxx");
  });

  it("throws ZenodoTokenError (with reason) when the token is invalid", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 } });

    const err = await configureZenodoToken("bad", "sandbox", 1, "").catch((e) => e);
    expect(err).toBeInstanceOf(ZenodoTokenError);
    expect(err.reason).toBe("invalid_token");
    expect(poolConnect).not.toHaveBeenCalled();
  });

  it("rolls back and rethrows when the upsert fails", async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: {} } as any);
    const client = makeClient();
    client.query.mockImplementation((sql: string) =>
      typeof sql === "string" && sql.includes("INSERT INTO zenodo_config")
        ? Promise.reject(new Error("db down"))
        : Promise.resolve({ rows: [] }),
    );
    poolConnect.mockResolvedValue(client as any);

    await expect(configureZenodoToken("secret-token-abcd", "sandbox", 1, "")).rejects.toThrow(
      "db down",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});

describe("removeZenodoConfig", () => {
  it("deletes the config and audits in one transaction", async () => {
    const client = makeClient();
    poolConnect.mockResolvedValue(client as any);

    await removeZenodoConfig("production", 3, "10.0.0.1");

    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("DELETE FROM zenodo_config");
    expect(mockedLogWithClient).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ action: "ZENODO_TOKEN_REMOVED", resourceId: "production" }),
    );
    expect(sqls).toContain("COMMIT");
  });

  it("rolls back and rethrows on failure", async () => {
    const client = makeClient();
    client.query.mockImplementation((sql: string) =>
      typeof sql === "string" && sql.includes("DELETE")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ rows: [] }),
    );
    poolConnect.mockResolvedValue(client as any);

    await expect(removeZenodoConfig("sandbox", 1, "")).rejects.toThrow("boom");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });
});

describe("getConfigStatus", () => {
  it("reports configured environments with hint and last_updated", async () => {
    const updated = new Date("2026-07-01T00:00:00Z");
    poolQuery.mockResolvedValueOnce({
      rows: [{ environment: "sandbox", token_hint: "xxxx...abcd", updated_at: updated }],
    });

    const status = await getConfigStatus();

    expect(status.sandbox).toEqual({
      configured: true,
      hint: "xxxx...abcd",
      last_updated: updated,
    });
    expect(status.production).toEqual({ configured: false, hint: null, last_updated: null });
  });
});

describe("getHealthStatus", () => {
  it("returns unconfigured defaults when no health rows exist", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // zenodo_health
      .mockResolvedValueOnce({ rows: [] }); // zenodo_config

    const status = await getHealthStatus();

    expect(status.sandbox.status).toBe("unconfigured");
    expect(status.sandbox.token_expiry_warning).toBe(false);
    expect(status.production.last_checked).toBeNull();
  });

  it("returns stored health plus a token-expiry warning inside 30 days", async () => {
    const lastChecked = new Date();
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days out
    poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            environment: "sandbox",
            status: "connected",
            error_reason: null,
            last_checked: lastChecked,
            last_success: lastChecked,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ environment: "sandbox", token_expires_at: soon }],
      });

    const status = await getHealthStatus();

    expect(status.sandbox.status).toBe("connected");
    expect(status.sandbox.token_expiry_warning).toBe(true);
    expect(status.sandbox.token_expires_at).toBe(soon);
  });

  it("does not warn when the token expires far in the future", async () => {
    const far = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ environment: "production", token_expires_at: far }] });

    const status = await getHealthStatus();
    expect(status.production.token_expiry_warning).toBe(false);
  });
});
