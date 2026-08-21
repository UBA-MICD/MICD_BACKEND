/**
 * Integration tests for the invite flow (PR3) against a live backend. An admin
 * creates an invited user; a code is minted directly via the invite service
 * (the API never returns the plaintext code — it is emailed), then redeemed over
 * the public /auth endpoints to set a password and land logged in. Self-skips if
 * the backend/DB are unreachable.
 */
import axios from "axios";
import { getAuthHeaderFor } from "../helpers/auth";
import { issueInvite } from "../../src/modules/auth/invite.service";
import { pool } from "../../src/db/pool";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const anyStatus = { validateStatus: () => true };

let available = false;
let adminHeaders: { Authorization: string };

const uniqueEmail = () =>
  `invitee-${Date.now()}-${Math.floor(Math.random() * 1e6)}@micd.local`;

async function createInvitedUser(): Promise<{ id: number; email: string }> {
  const email = uniqueEmail();
  const res = await axios.post(
    `${BASE_URL}/api/v1/users`,
    { name: "Invitee", email, role: "medico" },
    { headers: adminHeaders },
  );
  return { id: res.data.id, email };
}

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    await pool.query("SELECT 1");
    available = true;
    adminHeaders = await getAuthHeaderFor("admin");
  } catch {
    console.warn("Backend/DB not reachable — skipping invite integration tests");
  }
});

afterAll(async () => {
  if (available) await pool.end();
});

describe("GET /auth/invite/:code", () => {
  it("returns the invitee's email for a valid code", async () => {
    if (!available) return;
    const { id, email } = await createInvitedUser();
    const code = await issueInvite(id);
    const res = await axios.get(`${BASE_URL}/auth/invite/${code}`, anyStatus);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ email });
  });

  it("404s for an unknown code", async () => {
    if (!available) return;
    const res = await axios.get(`${BASE_URL}/auth/invite/not-a-real-code`, anyStatus);
    expect(res.status).toBe(404);
  });
});

describe("POST /auth/accept-invite", () => {
  it("sets the password, activates, and returns a live session", async () => {
    if (!available) return;
    const { id, email } = await createInvitedUser();
    const code = await issueInvite(id);

    const accept = await axios.post(
      `${BASE_URL}/auth/accept-invite`,
      { code, password: "a-strong-password" },
      anyStatus,
    );
    expect(accept.status).toBe(200);
    expect(accept.data.accessToken).toEqual(expect.any(String));
    expect(accept.data.user).toMatchObject({ email, role: "medico" });

    // The returned session is live — its token authorizes a protected route.
    // (Asserted via the token rather than a fresh /auth/login, which shares the
    // per-IP login rate limiter that the auth suite deliberately trips.)
    const authed = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: { Authorization: `Bearer ${accept.data.accessToken}` },
      ...anyStatus,
    });
    expect(authed.status).not.toBe(401);

    // The code is single-use — a second redeem fails.
    const reuse = await axios.post(
      `${BASE_URL}/auth/accept-invite`,
      { code, password: "another-password" },
      anyStatus,
    );
    expect(reuse.status).toBe(400);
  });

  it("rejects a too-short password with 400", async () => {
    if (!available) return;
    const { id } = await createInvitedUser();
    const code = await issueInvite(id);
    const res = await axios.post(
      `${BASE_URL}/auth/accept-invite`,
      { code, password: "short" },
      anyStatus,
    );
    expect(res.status).toBe(400);
  });
});
