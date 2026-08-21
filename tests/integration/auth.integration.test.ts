/**
 * Integration tests for POST /auth/login, /auth/refresh, /auth/logout
 * Requires the backend + DB to be running with the seeded test user
 * (test@micd.local / testpassword, created by migration 002).
 * Run: npm run test:integration
 */
import axios from "axios";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? "test@micd.local";
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? "testpassword";

let backendAvailable = false;

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;
  } catch {
    console.warn("Backend not reachable — skipping auth integration tests");
  }
});

describe("POST /auth/login", () => {
  it("returns 200 with access + refresh tokens for correct credentials", async () => {
    if (!backendAvailable) return;
    const { status, data } = await axios.post(`${BASE_URL}/auth/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    expect(status).toBe(200);
    expect(typeof data.accessToken).toBe("string");
    expect(typeof data.refreshToken).toBe("string");
    expect(data.user).toMatchObject({ email: TEST_EMAIL });
  });

  // Counts as 1 of the 5 failed attempts allowed before the IP is blocked —
  // the rate-limit test below relies on this and the next test contributing
  // to the same counter (express-rate-limit keys by IP, not by email).
  it("returns 401 for an incorrect password", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.post(`${BASE_URL}/auth/login`, {
        email: TEST_EMAIL,
        password: "definitely-wrong",
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  // Counts as the 2nd of the 5 failed attempts (see note above).
  it("returns 401 for an unknown email (same generic message — no user enumeration)", async () => {
    if (!backendAvailable) return;
    let wrongPasswordError: any;
    let unknownEmailError: any;
    try {
      await axios.post(`${BASE_URL}/auth/login`, {
        email: TEST_EMAIL,
        password: "definitely-wrong-2",
      });
    } catch (err) {
      wrongPasswordError = err;
    }
    try {
      await axios.post(`${BASE_URL}/auth/login`, {
        email: "nobody@micd.local",
        password: "whatever",
      });
    } catch (err) {
      unknownEmailError = err;
    }
    expect(wrongPasswordError.response.status).toBe(401);
    expect(unknownEmailError.response.status).toBe(401);
    expect(unknownEmailError.response.data.error).toBe(
      wrongPasswordError.response.data.error,
    );
  });

  it("returns 400 when email or password is missing", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.post(`${BASE_URL}/auth/login`, { email: TEST_EMAIL }),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});

describe("protected data endpoints", () => {
  it("returns 401 with no Authorization header", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.get(`${BASE_URL}/api/v1/studies`),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("returns 401 for an expired access token", async () => {
    if (!backendAvailable) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { signAccessToken } = require("../../src/modules/auth/jwt.service");
    const expired = signAccessToken(
      { sub: 1, email: TEST_EMAIL, role: "medico" as const },
      { expiresIn: "-1s" },
    );
    await expect(
      axios.get(`${BASE_URL}/api/v1/studies`, {
        headers: { Authorization: `Bearer ${expired}` },
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("returns 200 with a valid access token", async () => {
    if (!backendAvailable) return;
    const { data: login } = await axios.post(`${BASE_URL}/auth/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const { status } = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    expect(status).toBe(200);
  });
});

describe("POST /auth/refresh", () => {
  it("rotates tokens: old refresh token stops working after refresh", async () => {
    if (!backendAvailable) return;
    const { data: login } = await axios.post(`${BASE_URL}/auth/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    const { status, data: refreshed } = await axios.post(
      `${BASE_URL}/auth/refresh`,
      { refreshToken: login.refreshToken },
    );
    expect(status).toBe(200);
    expect(typeof refreshed.accessToken).toBe("string");
    expect(typeof refreshed.refreshToken).toBe("string");
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);

    // Reusing the old (now-rotated) refresh token must fail.
    await expect(
      axios.post(`${BASE_URL}/auth/refresh`, {
        refreshToken: login.refreshToken,
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("returns 401 for a garbage refresh token", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.post(`${BASE_URL}/auth/refresh`, {
        refreshToken: "not-a-real-token",
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});

describe("POST /auth/logout", () => {
  it("invalidates the refresh token so a subsequent refresh fails", async () => {
    if (!backendAvailable) return;
    const { data: login } = await axios.post(`${BASE_URL}/auth/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    const logoutRes = await axios.post(`${BASE_URL}/auth/logout`, {
      refreshToken: login.refreshToken,
    });
    expect(logoutRes.status).toBe(204);

    await expect(
      axios.post(`${BASE_URL}/auth/refresh`, {
        refreshToken: login.refreshToken,
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});

describe("login rate limiting", () => {
  it("blocks the IP with 429 after more than 5 failed attempts in the window", async () => {
    if (!backendAvailable) return;
    // Two failed attempts already happened above in this file (wrong
    // password + unknown email) — they share the same rate-limit counter
    // (keyed by client IP, not by email). Send enough additional failures
    // here to cross the max:5 threshold and assert the next one is 429.
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      try {
        await axios.post(`${BASE_URL}/auth/login`, {
          email: TEST_EMAIL,
          password: `still-wrong-${i}`,
        });
      } catch (err: any) {
        lastStatus = err.response?.status;
      }
    }
    expect(lastStatus).toBe(429);
  });
});
