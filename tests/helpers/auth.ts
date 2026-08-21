import axios from "axios";
import { signAccessToken, verifyAccessToken } from "../../src/modules/auth/jwt.service";
import { Role } from "../../src/shared/roles";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? "test@micd.local";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? "testpassword";

let cachedHeader: { Authorization: string } | null = null;

export async function getAuthHeader(): Promise<{ Authorization: string }> {
  if (cachedHeader) return cachedHeader;
  const { data } = await axios.post(`${BASE_URL}/auth/login`, {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  cachedHeader = { Authorization: `Bearer ${data.accessToken}` };
  return cachedHeader;
}

const roleHeaderCache = new Map<Role, { Authorization: string }>();

/**
 * A Bearer header carrying a given role. The seeded test user is a `medico`, so
 * that role logs in for real. `admin`/`investigador` are minted by re-signing
 * that user's verified claims with the target role — a validly-signed token the
 * backend accepts (the tests container shares the backend's JWT_SECRET), which
 * exercises the requireRole wiring end-to-end without needing the user-creation
 * API. Once that API lands (PR2), these can switch to real seeded accounts.
 */
export async function getAuthHeaderFor(
  role: Role,
): Promise<{ Authorization: string }> {
  const cached = roleHeaderCache.get(role);
  if (cached) return cached;

  const base = await getAuthHeader();
  let header: { Authorization: string };
  if (role === "medico") {
    header = base;
  } else {
    const claims = verifyAccessToken(base.Authorization.slice("Bearer ".length));
    const token = signAccessToken({ sub: claims.sub, email: claims.email, role });
    header = { Authorization: `Bearer ${token}` };
  }
  roleHeaderCache.set(role, header);
  return header;
}
