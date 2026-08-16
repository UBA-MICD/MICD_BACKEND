import { pool } from "../../../src/db/pool";
import { throttle, THROTTLE_AT } from "../../../src/modules/zenodo/zenodo-rate-limit.service";

jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn() } }));

const poolQuery = pool.query as jest.Mock;

beforeEach(() => jest.resetAllMocks());

describe("throttle — window edge cases", () => {
  it("records the request without sleeping when the MIN query returns no oldest row", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // prune
      .mockResolvedValueOnce({ rows: [{ count: String(THROTTLE_AT) }] }) // count at limit
      .mockResolvedValueOnce({ rows: [{ oldest: null }] }) // MIN(requested_at) empty
      .mockResolvedValueOnce({ rows: [] }); // recordRequest

    await throttle("production"); // must resolve without sleeping

    expect(poolQuery).toHaveBeenCalledTimes(4);
    const insert = poolQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO zenodo_api_requests"),
    );
    expect(insert).toBeDefined();
  });
});
