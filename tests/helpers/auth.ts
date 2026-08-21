import axios from "axios";
import { Client } from "pg";
import { signAccessToken } from "../../src/modules/auth/jwt.service";
import { dbConfig } from "../../src/config/env";
import { Role } from "../../src/shared/roles";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? "test@micd.local";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? "testpassword";

let cachedHeader: { Authorization: string } | null = null;

/** A real login as the seeded test user (used where a real session matters). */
export async function getAuthHeader(): Promise<{ Authorization: string }> {
  if (cachedHeader) return cachedHeader;
  const { data } = await axios.post(`${BASE_URL}/auth/login`, {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  cachedHeader = { Authorization: `Bearer ${data.accessToken}` };
  return cachedHeader;
}

// The seeded test user's real id + email, read once directly from the DB (a
// one-shot client, fully closed). Used to mint role tokens WITHOUT logging in —
// deliberately: the auth suite trips the shared per-IP login rate limiter, so
// every extra login in a beforeAll risks a 429 that poisons other suites. The
// real id also satisfies the audit_log.user_id foreign key when an admin token
// drives a write (e.g. creating a user).
let claimsPromise: Promise<{ sub: number; email: string }> | null = null;
function testUserClaims(): Promise<{ sub: number; email: string }> {
  claimsPromise ??= (async () => {
    const client = new Client(dbConfig);
    await client.connect();
    try {
      const { rows } = await client.query<{ id: number; email: string }>(
        "SELECT id, email FROM users WHERE email = $1",
        [TEST_EMAIL],
      );
      if (!rows[0]) throw new Error(`test user ${TEST_EMAIL} not found`);
      return { sub: rows[0].id, email: rows[0].email };
    } finally {
      await client.end();
    }
  })();
  return claimsPromise;
}

const roleHeaderCache = new Map<Role, { Authorization: string }>();

/**
 * A Bearer header carrying a given role, minted by signing the seeded test
 * user's real claims (id/email) with the target role. The tests container shares
 * the backend's JWT_SECRET, so these are validly-signed tokens the backend
 * accepts — exercising the requireRole wiring end-to-end with no login (see the
 * rate-limiter note above).
 */
export async function getAuthHeaderFor(
  role: Role,
): Promise<{ Authorization: string }> {
  const cached = roleHeaderCache.get(role);
  if (cached) return cached;

  const { sub, email } = await testUserClaims();
  const token = signAccessToken({ sub, email, role });
  const header = { Authorization: `Bearer ${token}` };
  roleHeaderCache.set(role, header);
  return header;
}
