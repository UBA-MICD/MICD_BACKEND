/**
 * Integration tests for GET /api/v1/pathologies (the classification catalog).
 * Requires a live backend + DB. Run: npm run test:integration
 */
import axios from "axios";
import { getAuthHeader } from "../helpers/auth";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const EXPECTED_KEYS = [
  "acv",
  "hemorragia",
  "tumor",
  "desmielinizante",
  "normales",
  "otros",
];

let backendAvailable = false;
let authHeader: { Authorization: string } = { Authorization: "" };

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;
    authHeader = await getAuthHeader();
  } catch {
    console.warn("Backend not reachable — skipping pathologies integration tests");
  }
});

describe("GET /api/v1/pathologies", () => {
  it("returns the seeded catalog as { id, key }", async () => {
    if (!backendAvailable) return;
    const { data, status } = await axios.get(
      `${BASE_URL}/api/v1/pathologies`,
      { headers: authHeader },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);

    const keys = data.map((p: { key: string }) => p.key);
    for (const k of EXPECTED_KEYS) expect(keys).toContain(k);

    for (const p of data) {
      expect(typeof p.id).toBe("number");
      expect(typeof p.key).toBe("string");
      expect(p.key.length).toBeLessThanOrEqual(15);
    }
  });

  it("rejects an unauthenticated request → 401", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.get(`${BASE_URL}/api/v1/pathologies`),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});
