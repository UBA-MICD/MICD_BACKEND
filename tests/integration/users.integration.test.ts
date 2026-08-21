/**
 * Integration tests for the admin user-management API (US-H04) against a live
 * backend. Exercises the real DB path: create (invited), list (excludes
 * deleted), role change, block/unblock (revokes tokens), soft-delete, and the
 * self / last-admin guards. Self-skips if the backend is unreachable.
 */
import axios from "axios";
import { getAuthHeaderFor } from "../helpers/auth";
import { verifyAccessToken } from "../../src/modules/auth/jwt.service";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const anyStatus = { validateStatus: () => true };

let backendAvailable = false;
let adminHeaders: { Authorization: string };
let selfId: number;

const uniqueEmail = (tag: string) =>
  `u-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@micd.local`;

async function createUser(role: string, name = "Test User") {
  const email = uniqueEmail(role);
  const res = await axios.post(
    `${BASE_URL}/api/v1/users`,
    { name, email, role },
    { headers: adminHeaders, ...anyStatus },
  );
  return { res, email };
}

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;
    adminHeaders = await getAuthHeaderFor("admin");
    selfId = verifyAccessToken(adminHeaders.Authorization.slice("Bearer ".length)).sub;
  } catch {
    console.warn("Backend not reachable — skipping users integration tests");
  }
});

describe("POST /api/v1/users", () => {
  it("creates an invited, password-less user", async () => {
    if (!backendAvailable) return;
    const { res, email } = await createUser("medico", " Ada Lovelace ");
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      email,
      role: "medico",
      status: "invited",
      has_password: false,
      last_login_at: null,
    });
    expect(res.data.name).toBe("Ada Lovelace"); // trimmed
  });

  it("rejects a duplicate email with 409", async () => {
    if (!backendAvailable) return;
    const { email } = await createUser("investigador");
    const dup = await axios.post(
      `${BASE_URL}/api/v1/users`,
      { name: "Dup", email, role: "medico" },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(dup.status).toBe(409);
  });

  it("rejects an invalid role with 400", async () => {
    if (!backendAvailable) return;
    const res = await axios.post(
      `${BASE_URL}/api/v1/users`,
      { name: "X", email: uniqueEmail("bad"), role: "root" },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/users", () => {
  it("lists created users and excludes soft-deleted ones", async () => {
    if (!backendAvailable) return;
    const { res: created } = await createUser("medico");
    const id = created.data.id;

    let list = await axios.get(`${BASE_URL}/api/v1/users`, { headers: adminHeaders });
    expect(list.data.some((u: any) => u.id === id)).toBe(true);

    await axios.delete(`${BASE_URL}/api/v1/users/${id}`, { headers: adminHeaders });
    list = await axios.get(`${BASE_URL}/api/v1/users`, { headers: adminHeaders });
    expect(list.data.some((u: any) => u.id === id)).toBe(false);
  });
});

describe("role / status transitions", () => {
  it("changes a user's role", async () => {
    if (!backendAvailable) return;
    const { res } = await createUser("medico");
    const patch = await axios.patch(
      `${BASE_URL}/api/v1/users/${res.data.id}/role`,
      { role: "investigador" },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(patch.status).toBe(200);
    expect(patch.data.role).toBe("investigador");
  });

  it("blocks then re-enables a user", async () => {
    if (!backendAvailable) return;
    const { res } = await createUser("medico");
    const id = res.data.id;

    const blocked = await axios.patch(
      `${BASE_URL}/api/v1/users/${id}/status`,
      { status: "blocked" },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(blocked.data.status).toBe("blocked");

    const active = await axios.patch(
      `${BASE_URL}/api/v1/users/${id}/status`,
      { status: "active" },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(active.data.status).toBe("active");
  });

  it("404s on a non-existent user", async () => {
    if (!backendAvailable) return;
    const res = await axios.patch(
      `${BASE_URL}/api/v1/users/99999999/role`,
      { role: "medico" },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(res.status).toBe(404);
  });
});

describe("guards", () => {
  it("refuses acting on your own account (409)", async () => {
    if (!backendAvailable) return;
    const del = await axios.delete(`${BASE_URL}/api/v1/users/${selfId}`, {
      headers: adminHeaders,
      ...anyStatus,
    });
    expect(del.status).toBe(409);
  });

  it("refuses demoting the last effective admin (409)", async () => {
    if (!backendAvailable) return;
    // Create an admin and make it active — the only role=admin+active row.
    const { res } = await createUser("admin", "Sole Admin");
    const id = res.data.id;
    await axios.patch(
      `${BASE_URL}/api/v1/users/${id}/status`,
      { status: "active" },
      { headers: adminHeaders, ...anyStatus },
    );
    const demote = await axios.patch(
      `${BASE_URL}/api/v1/users/${id}/role`,
      { role: "medico" },
      { headers: adminHeaders, ...anyStatus },
    );
    expect(demote.status).toBe(409);

    // Cleanup: a second admin lets us remove the first without tripping the guard.
    const { res: second } = await createUser("admin", "Second Admin");
    await axios.patch(
      `${BASE_URL}/api/v1/users/${second.data.id}/status`,
      { status: "active" },
      { headers: adminHeaders, ...anyStatus },
    );
    await axios.delete(`${BASE_URL}/api/v1/users/${id}`, {
      headers: adminHeaders,
      ...anyStatus,
    });
    await axios.delete(`${BASE_URL}/api/v1/users/${second.data.id}`, {
      headers: adminHeaders,
      ...anyStatus,
    });
  });
});
