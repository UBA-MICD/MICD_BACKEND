/**
 * Integration tests for password recovery against a live backend. Active users
 * are created through the real invite flow; reset codes are minted directly via
 * the service (the API never returns the plaintext code — it is emailed), then
 * redeemed over the public /auth endpoints. Self-skips if the backend/DB are
 * unreachable.
 */
import axios from "axios";
import { getAuthHeaderFor } from "../helpers/auth";
import { issueInvite } from "../../src/modules/auth/invite.service";
import { issueReset } from "../../src/modules/auth/password-reset.service";
import { verifyPassword } from "../../src/modules/auth/password.service";
import { pool } from "../../src/db/pool";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const anyStatus = { validateStatus: () => true };

let available = false;
let adminHeaders: { Authorization: string };

const uniqueEmail = () =>
  `reset-${Date.now()}-${Math.floor(Math.random() * 1e6)}@micd.local`;

async function createInvitedUser(): Promise<{ id: number; email: string }> {
  const email = uniqueEmail();
  const res = await axios.post(
    `${BASE_URL}/api/v1/users`,
    { name: "Reset user", email, role: "medico" },
    { headers: adminHeaders },
  );
  return { id: res.data.id, email };
}

/** An active user with a known password and a live refresh token. */
async function createActiveUser(): Promise<{
  id: number;
  email: string;
  refreshToken: string;
}> {
  const { id, email } = await createInvitedUser();
  const code = await issueInvite(id);
  const res = await axios.post(`${BASE_URL}/auth/accept-invite`, {
    code,
    password: "original-password",
  });
  return { id, email, refreshToken: res.data.refreshToken };
}

async function resetRowCount(userId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM password_resets WHERE user_id = $1",
    [userId],
  );
  return Number(rows[0].n);
}

/** forgot-password works after responding, so poll for its side effect. */
async function waitForResetRow(userId: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    n = await resetRowCount(userId);
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
  return n;
}

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    await pool.query("SELECT 1");
    available = true;
    adminHeaders = await getAuthHeaderFor("admin");
  } catch {
    console.warn("Backend/DB not reachable — skipping password reset integration tests");
  }
});

afterAll(async () => {
  if (available) await pool.end();
});

describe("POST /auth/forgot-password", () => {
  it("400s without an email", async () => {
    if (!available) return;
    const res = await axios.post(`${BASE_URL}/auth/forgot-password`, {}, anyStatus);
    expect(res.status).toBe(400);
  });

  it("answers 202 for an unknown email (no enumeration)", async () => {
    if (!available) return;
    const res = await axios.post(
      `${BASE_URL}/auth/forgot-password`,
      { email: "nobody-here@micd.local" },
      anyStatus,
    );
    expect(res.status).toBe(202);
    expect(res.data).toEqual({ ok: true });
  });

  it("answers 202 and issues a code for an active user, then cools down", async () => {
    if (!available) return;
    const { id, email } = await createActiveUser();

    const res = await axios.post(
      `${BASE_URL}/auth/forgot-password`,
      { email, locale: "en" },
      anyStatus,
    );
    expect(res.status).toBe(202);
    expect(await waitForResetRow(id)).toBe(1);

    // Inside the cooldown window no second code is issued.
    expect(await issueReset(id)).toBeNull();
    expect(await resetRowCount(id)).toBe(1);
  });

  it("answers 202 but issues nothing for an invited (not yet active) user", async () => {
    if (!available) return;
    const { id, email } = await createInvitedUser();
    const res = await axios.post(`${BASE_URL}/auth/forgot-password`, { email }, anyStatus);
    expect(res.status).toBe(202);
    expect(await waitForResetRow(id, 800)).toBe(0);
  });
});

describe("GET /auth/reset-password/:code", () => {
  it("returns the account email for a valid code", async () => {
    if (!available) return;
    const { id, email } = await createActiveUser();
    const code = (await issueReset(id))!;
    const res = await axios.get(`${BASE_URL}/auth/reset-password/${code}`, anyStatus);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ email });
  });

  it("404s for an unknown code", async () => {
    if (!available) return;
    const res = await axios.get(`${BASE_URL}/auth/reset-password/not-a-real-code`, anyStatus);
    expect(res.status).toBe(404);
  });
});

describe("POST /auth/reset-password", () => {
  it("sets the password, kills old sessions, and returns a live session", async () => {
    if (!available) return;
    const { id, email, refreshToken: oldRefresh } = await createActiveUser();
    const code = (await issueReset(id))!;

    const res = await axios.post(
      `${BASE_URL}/auth/reset-password`,
      { code, password: "brand-new-password" },
      anyStatus,
    );
    expect(res.status).toBe(200);
    expect(res.data.user).toMatchObject({ id, email, role: "medico" });

    // The new password is stored (checked against the DB rather than via
    // /auth/login, whose per-IP limiter the auth suite deliberately trips).
    const { rows } = await pool.query<{ password: string }>(
      "SELECT password FROM users WHERE id = $1",
      [id],
    );
    expect(await verifyPassword("brand-new-password", rows[0].password)).toBe(true);
    expect(await verifyPassword("original-password", rows[0].password)).toBe(false);

    // The returned session is live.
    const authed = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: { Authorization: `Bearer ${res.data.accessToken}` },
      ...anyStatus,
    });
    expect(authed.status).not.toBe(401);

    // Sessions from before the reset are gone.
    const stale = await axios.post(
      `${BASE_URL}/auth/refresh`,
      { refreshToken: oldRefresh },
      anyStatus,
    );
    expect(stale.status).toBe(401);

    // The code is single-use.
    const reuse = await axios.post(
      `${BASE_URL}/auth/reset-password`,
      { code, password: "yet-another-password" },
      anyStatus,
    );
    expect(reuse.status).toBe(400);
  });

  it("rejects a too-short password without burning the code", async () => {
    if (!available) return;
    const { id } = await createActiveUser();
    const code = (await issueReset(id))!;

    const res = await axios.post(
      `${BASE_URL}/auth/reset-password`,
      { code, password: "short" },
      anyStatus,
    );
    expect(res.status).toBe(400);

    const still = await axios.get(`${BASE_URL}/auth/reset-password/${code}`, anyStatus);
    expect(still.status).toBe(200);
  });

  it("refuses a code whose account was blocked after it was issued", async () => {
    if (!available) return;
    const { id } = await createActiveUser();
    const code = (await issueReset(id))!;
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [id]);

    const lookup = await axios.get(`${BASE_URL}/auth/reset-password/${code}`, anyStatus);
    expect(lookup.status).toBe(404);

    const res = await axios.post(
      `${BASE_URL}/auth/reset-password`,
      { code, password: "brand-new-password" },
      anyStatus,
    );
    expect(res.status).toBe(400);
  });
});
