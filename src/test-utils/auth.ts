import axios from "axios";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@micd.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "change-me-admin-password";

let cachedHeader: { Authorization: string } | null = null;

export async function getAuthHeader(): Promise<{ Authorization: string }> {
  if (cachedHeader) return cachedHeader;
  const { data } = await axios.post(`${BASE_URL}/auth/login`, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  cachedHeader = { Authorization: `Bearer ${data.accessToken}` };
  return cachedHeader;
}
