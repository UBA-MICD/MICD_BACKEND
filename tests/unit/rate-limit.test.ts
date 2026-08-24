/**
 * Rate limiting, driven through the real app so these pin the wiring rather
 * than a replica of it.
 *
 * Budgets are per IP. In the desktop deployment the whole app is a single user
 * behind one loopback address doing bursty bulk work — a seed run uploads
 * hundreds of DICOMs back to back — so the upload and global budgets exist to
 * bound abuse, not to pace a legitimate client, and the defaults are
 * correspondingly generous. Login stays tight because credential stuffing is
 * the threat there.
 */
import request from "supertest";

const ORIGINAL_ENV = { ...process.env };

/** Re-import the real app with the given rate-limit budgets. */
function appWith(env: Record<string, string> = {}) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("RATE_LIMIT_")) delete process.env[key];
  }
  Object.assign(process.env, env);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../src/app").app;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("refresh rate limiting", () => {
  // A syntactically valid but unsigned token fails verification before any DB
  // access, so these requests exercise the limiter without a live Postgres.
  const bogus = { refreshToken: "not-a-real-token" };

  it("serves requests up to the budget, then answers 429", async () => {
    const app = appWith({ RATE_LIMIT_REFRESH_MAX: "3" });

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/auth/refresh").send(bogus);
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post("/auth/refresh").send(bogus);
    expect(blocked.status).toBe(429);
  });

  it("was previously unlimited — the limiter is what stops the fourth attempt", async () => {
    const app = appWith({ RATE_LIMIT_REFRESH_MAX: "1" });

    await request(app).post("/auth/refresh").send(bogus);
    const blocked = await request(app).post("/auth/refresh").send(bogus);

    expect(blocked.status).toBe(429);
  });
});

describe("global rate limiting", () => {
  it("answers 429 once the global budget is spent", async () => {
    const app = appWith({ RATE_LIMIT_GLOBAL_MAX: "2" });

    await request(app).get("/api/docs/openapi.json");
    await request(app).get("/api/docs/openapi.json");
    const blocked = await request(app).get("/api/docs/openapi.json");

    expect(blocked.status).toBe(429);
  });

  it("exempts the liveness probe so a traffic spike cannot get the container restarted", async () => {
    const app = appWith({ RATE_LIMIT_GLOBAL_MAX: "1" });

    await request(app).get("/api/docs/openapi.json");

    // Budget is already spent; the orchestrator's probe must still succeed.
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/api/livez");
      expect(res.status).toBe(200);
    }
  });
});

describe("rate limit budgets", () => {
  it("keeps login tight and bulk paths generous by default", () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rateLimitConfig } = require("../../src/config/env");

    expect(rateLimitConfig.loginMax).toBe(5);
    // A single seed run uploads hundreds of files from one IP.
    expect(rateLimitConfig.uploadMax).toBeGreaterThanOrEqual(500);
    expect(rateLimitConfig.globalMax).toBeGreaterThanOrEqual(1000);
  });
});
