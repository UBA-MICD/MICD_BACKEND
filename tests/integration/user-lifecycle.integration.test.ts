/**
 * Integration tests for two admin user-lifecycle flows against a live backend:
 *
 *  1. Re-creating a deleted user. An admin creates a user, the user redeems the
 *     invite (active), the admin deletes them (soft-delete), then creates the
 *     SAME email again — that must be allowed, and must yield a brand-new,
 *     independent account (new id, invited, no password), never a resurrection
 *     of the old row or its credentials.
 *  2. Re-sending an invite to a still-pending user. POST /:id/invite mints a new
 *     code and voids the previous unconsumed one, so only the latest link works.
 *
 * Invite codes are minted directly via the invite service (the API only emails
 * them). Self-skips if the backend/DB are unreachable.
 */
import axios from "axios";
import { getAuthHeaderFor } from "../helpers/auth";
import { issueInvite } from "../../src/modules/auth/invite.service";
import { pool } from "../../src/db/pool";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const anyStatus = { validateStatus: () => true };

let available = false;
let adminHeaders: { Authorization: string };

const uniqueEmail = (tag: string) =>
  `lifecycle-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@micd.local`;

function createUser(email: string, name = "Lifecycle User", role = "medico") {
  return axios.post(
    `${BASE_URL}/api/v1/users`,
    { name, email, role },
    { headers: adminHeaders, ...anyStatus },
  );
}

function acceptInvite(code: string, password: string) {
  return axios.post(
    `${BASE_URL}/auth/accept-invite`,
    { code, password },
    anyStatus,
  );
}

async function listedUsers(): Promise<Array<{ id: number; email: string; status: string }>> {
  const res = await axios.get(`${BASE_URL}/api/v1/users`, { headers: adminHeaders });
  return res.data;
}

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    await pool.query("SELECT 1");
    available = true;
    adminHeaders = await getAuthHeaderFor("admin");
  } catch {
    console.warn("Backend/DB not reachable — skipping user-lifecycle integration tests");
  }
});

afterAll(async () => {
  if (available) await pool.end();
});

describe("create → activate → delete → create again (same email)", () => {
  it("allows re-creating a deleted user as a fresh, independent account", async () => {
    if (!available) return;
    const email = uniqueEmail("recreate");

    // 1. Admin creates the user (invited).
    const first = await createUser(email, "First Life", "investigador");
    expect(first.status).toBe(201);
    const firstId: number = first.data.id;

    // 2. The user activates the account by redeeming the invite.
    const accepted = await acceptInvite(await issueInvite(firstId), "first-life-password");
    expect(accepted.status).toBe(200);
    expect(accepted.data.user).toMatchObject({ id: firstId, email });

    // 3. Admin deletes the user.
    const del = await axios.delete(`${BASE_URL}/api/v1/users/${firstId}`, {
      headers: adminHeaders,
      ...anyStatus,
    });
    expect(del.status).toBe(204);
    expect((await listedUsers()).some((u) => u.email === email)).toBe(false);

    // 4. Admin creates the same email again — must be allowed.
    const second = await createUser(email, "Second Life", "medico");
    expect(second.status).toBe(201);
    expect(second.data).toMatchObject({
      email,
      name: "Second Life",
      role: "medico",
      status: "invited",
      has_password: false,
      last_login_at: null,
    });
    // A new account, not the old row brought back.
    expect(second.data.id).not.toBe(firstId);

    // Exactly one live row for the email, and it is the new one.
    const live = (await listedUsers()).filter((u) => u.email === email);
    expect(live).toEqual([expect.objectContaining({ id: second.data.id, status: "invited" })]);

    // The deleted row is kept (audit trail), still deleted.
    const { rows: old } = await pool.query(
      "SELECT status FROM users WHERE id = $1",
      [firstId],
    );
    expect(old[0]?.status).toBe("deleted");

    // The new account can be activated and the session is bound to the NEW id.
    const reaccepted = await acceptInvite(
      await issueInvite(second.data.id),
      "second-life-password",
    );
    expect(reaccepted.status).toBe(200);
    expect(reaccepted.data.user).toMatchObject({ id: second.data.id, email, role: "medico" });
  });

  it("still rejects a duplicate while the existing account is live", async () => {
    if (!available) return;
    const email = uniqueEmail("dup");
    expect((await createUser(email)).status).toBe(201);
    const dup = await createUser(email);
    expect(dup.status).toBe(409);
  });

  it("treats the email case-insensitively when re-creating", async () => {
    if (!available) return;
    const email = uniqueEmail("case");
    const first = await createUser(email);
    expect(first.status).toBe(201);
    await axios.delete(`${BASE_URL}/api/v1/users/${first.data.id}`, { headers: adminHeaders });

    const again = await createUser(email.toUpperCase());
    expect(again.status).toBe(201);
    expect(again.data.email).toBe(email);
    expect((await createUser(email)).status).toBe(409);
  });

  it("a pending invite of a deleted user cannot resurrect it", async () => {
    if (!available) return;
    const email = uniqueEmail("ghost");
    const first = await createUser(email);
    const staleCode = await issueInvite(first.data.id);
    await axios.delete(`${BASE_URL}/api/v1/users/${first.data.id}`, { headers: adminHeaders });

    // The deleted user's outstanding link is dead...
    expect((await axios.get(`${BASE_URL}/auth/invite/${staleCode}`, anyStatus)).status).toBe(404);
    expect((await acceptInvite(staleCode, "ghost-password-123")).status).toBe(400);
    const { rows } = await pool.query("SELECT status FROM users WHERE id = $1", [first.data.id]);
    expect(rows[0]?.status).toBe("deleted");

    // ...and the email is free to be invited again.
    expect((await createUser(email)).status).toBe(201);
  });
});

describe("POST /api/v1/users/:id/invite (resend invitation)", () => {
  it("issues a new code and voids the previous unexpired one", async () => {
    if (!available) return;
    const created = await createUser(uniqueEmail("resend"));
    expect(created.status).toBe(201);
    const id: number = created.data.id;

    const oldCode = await issueInvite(id);
    expect((await axios.get(`${BASE_URL}/auth/invite/${oldCode}`, anyStatus)).status).toBe(200);

    const resend = await axios.post(`${BASE_URL}/api/v1/users/${id}/invite`, null, {
      headers: adminHeaders,
      ...anyStatus,
    });
    expect(resend.status).toBe(200);
    expect(resend.data).toMatchObject({ id, status: "invited" });

    // The old link no longer works.
    expect((await axios.get(`${BASE_URL}/auth/invite/${oldCode}`, anyStatus)).status).toBe(404);
    expect((await acceptInvite(oldCode, "old-code-password")).status).toBe(400);

    // Exactly one live code remains (the resent one), with a fresh expiry.
    const { rows } = await pool.query(
      `SELECT expires_at FROM user_invites
        WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
      [id],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses to resend to an already-active user", async () => {
    if (!available) return;
    const created = await createUser(uniqueEmail("active"));
    await acceptInvite(await issueInvite(created.data.id), "active-user-password");
    const resend = await axios.post(
      `${BASE_URL}/api/v1/users/${created.data.id}/invite`,
      null,
      { headers: adminHeaders, ...anyStatus },
    );
    expect(resend.status).toBe(409);
  });

  it("is admin-only", async () => {
    if (!available) return;
    const created = await createUser(uniqueEmail("rbac"));
    const res = await axios.post(
      `${BASE_URL}/api/v1/users/${created.data.id}/invite`,
      null,
      { headers: await getAuthHeaderFor("medico"), ...anyStatus },
    );
    expect(res.status).toBe(403);
  });
});
