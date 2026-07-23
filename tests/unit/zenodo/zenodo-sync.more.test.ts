import { pool } from "../../../src/db/pool";
import { runSync } from "../../../src/modules/zenodo/zenodo-sync.service";

jest.mock("axios");
jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn() } }));
jest.mock("../../../src/modules/zenodo/zenodo.service", () => ({
  getStoredToken: jest.fn().mockResolvedValue(null),
  ZENODO_ENVIRONMENTS: ["sandbox", "production"],
}));
jest.mock("../../../src/modules/zenodo/zenodo-rate-limit.service", () => ({
  throttle: jest.fn().mockResolvedValue(undefined),
  THROTTLE_AT: 50,
  FIFTY_GB: 50 * 1024 * 1024 * 1024,
}));

const poolQuery = pool.query as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("runSync — failure path", () => {
  it("marks the log failed and rethrows when the imported-records query fails", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // INSERT sync_log
      .mockRejectedValueOnce(new Error("relation studies does not exist")) // getImportedRecords
      .mockResolvedValue({ rows: [] }); // UPDATE sync_log failed

    await expect(runSync()).rejects.toThrow("relation studies does not exist");

    const failedUpdate = poolQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("status='failed'"),
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![1]).toContain("relation studies does not exist");
  });
});
