import { pool } from "../../../src/db/pool";
import { AUDIT_ACTIONS, logAction, logActionWithClient } from "../../../src/shared/audit";

jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn() } }));

const poolQuery = pool.query as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const ENTRY = {
  userId: 5,
  action: AUDIT_ACTIONS.ZENODO_TOKEN_CONFIGURED,
  resourceId: "sandbox",
  ip: "10.0.0.1",
};

describe("audit", () => {
  it("logAction inserts one audit_log row via the shared pool", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });

    await logAction(ENTRY);

    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO audit_log"), [
      5,
      "ZENODO_TOKEN_CONFIGURED",
      "sandbox",
      "10.0.0.1",
      null,
    ]);
  });

  it("logActionWithClient uses the provided transaction client", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await logActionWithClient(client as any, {
      ...ENTRY,
      action: AUDIT_ACTIONS.ZENODO_TOKEN_REMOVED,
    });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO audit_log"), [
      5,
      "ZENODO_TOKEN_REMOVED",
      "sandbox",
      "10.0.0.1",
      null,
    ]);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
