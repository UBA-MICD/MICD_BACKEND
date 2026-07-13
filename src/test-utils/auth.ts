import axios from "axios";

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
