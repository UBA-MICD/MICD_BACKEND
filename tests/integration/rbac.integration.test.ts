/**
 * End-to-end RBAC enforcement over real HTTP. Proves the requireRole wiring
 * against a live backend: an allowed role reaches the handler (any status but
 * 401/403), a disallowed role is refused with a 403 Forbidden body, and a
 * request with no token is 401.
 *
 * Requires the backend + DB to be running (self-skips otherwise). The route
 * matrix itself is exhaustively asserted in tests/unit/rbac-matrix.test.ts —
 * this suite is the wiring proof over a representative slice.
 */
import axios from "axios";
import { getAuthHeader, getAuthHeaderFor } from "../helpers/auth";
import { ROLES, Role } from "../../src/shared/roles";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const anyStatus = { validateStatus: () => true };

let backendAvailable = false;

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;
  } catch {
    console.warn("Backend not reachable — skipping RBAC integration tests");
  }
});

// Safe, non-mutating routes, one per authorization tier.
interface Case {
  label: string;
  method: "get" | "delete";
  path: string;
  allowed: Role[];
}

const cases: Case[] = [
  { label: "studies list (all roles)", method: "get", path: "/api/v1/studies", allowed: [...ROLES] },
  { label: "audit log (admin only)", method: "get", path: "/api/v1/activity/", allowed: ["admin"] },
  { label: "audit export (admin only)", method: "get", path: "/api/v1/activity/export", allowed: ["admin"] },
  { label: "zenodo sync config (admin only)", method: "get", path: "/api/v1/zenodo/config/sync", allowed: ["admin"] },
  { label: "zenodo quota (clinical staff)", method: "get", path: "/api/v1/zenodo/quota", allowed: ["admin", "medico"] },
  // A write route: disallowed roles must be refused before the handler. A bogus
  // id keeps the admin-allowed case side-effect-free (Orthanc 404, no delete).
  { label: "delete study (admin only)", method: "delete", path: "/api/studies/rbac-nonexistent-id", allowed: ["admin"] },
];

describe("RBAC enforcement", () => {
  for (const { label, method, path, allowed } of cases) {
    for (const role of ROLES) {
      const permitted = allowed.includes(role);
      it(`${label}: ${role} is ${permitted ? "allowed" : "forbidden"}`, async () => {
        if (!backendAvailable) return;
        const headers = await getAuthHeaderFor(role);
        const res = await axios.request({
          method,
          url: `${BASE_URL}${path}`,
          headers,
          ...anyStatus,
        });
        if (permitted) {
          expect(res.status).not.toBe(401);
          expect(res.status).not.toBe(403);
        } else {
          expect(res.status).toBe(403);
          expect(res.data).toMatchObject({ error: "Forbidden" });
        }
      });
    }
  }

  it("refuses a request with no token (401)", async () => {
    if (!backendAvailable) return;
    const res = await axios.get(`${BASE_URL}/api/v1/studies`, anyStatus);
    expect(res.status).toBe(401);
  });

  it("still authenticates the seeded medico via a real login", async () => {
    if (!backendAvailable) return;
    const header = await getAuthHeader();
    expect(header.Authorization).toMatch(/^Bearer .+/);
  });
});
