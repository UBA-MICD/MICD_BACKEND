/**
 * CORS policy. The desktop (Electron) client is a native HTTP caller: it sends
 * no Origin header at all, the same as the seeder or curl. CORS is enforced by
 * browsers, so rejecting originless requests would break the desktop app while
 * stopping no attacker — those requests are therefore always allowed, and the
 * allowlist only governs genuine cross-origin browser callers.
 *
 * The browser client is served same-origin through nginx, so it does not depend
 * on these headers either.
 */
import express from "express";
import request from "supertest";

import { isOriginAllowed } from "../../src/middleware/cors.middleware";

const ORIGINAL_ENV = { ...process.env };

// env.ts refuses to load under NODE_ENV=production while any secret is still on
// its placeholder, so the production cases have to supply real-looking ones.
const PRODUCTION_SECRETS = {
  JWT_SECRET: "test-access-secret",
  JWT_REFRESH_SECRET: "test-refresh-secret",
  DB_PASSWORD: "test-db-password",
  ORTHANC_PASSWORD: "test-orthanc-password",
};

/** Fresh express app with the CORS middleware rebuilt from the given env. */
function appWith(env: { ALLOWED_ORIGINS?: string; NODE_ENV?: string }) {
  delete process.env.ALLOWED_ORIGINS;
  Object.assign(process.env, PRODUCTION_SECRETS, env);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { corsMiddleware } = require("../../src/middleware/cors.middleware");

  const app = express();
  app.use(corsMiddleware);
  app.get("/ping", (_req: any, res: any) => res.json({ ok: true }));
  return app;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isOriginAllowed", () => {
  it("allows a request with no Origin header — the desktop app and other native clients", () => {
    expect(isOriginAllowed(undefined, [], true)).toBe(true);
    expect(isOriginAllowed(undefined, ["https://micd.example"], true)).toBe(true);
  });

  it("allows an origin on the allowlist", () => {
    expect(isOriginAllowed("https://micd.example", ["https://micd.example"], true)).toBe(true);
  });

  it("denies an origin that is not on a configured allowlist", () => {
    expect(isOriginAllowed("https://evil.example", ["https://micd.example"], true)).toBe(false);
  });

  it("denies cross-origin browser callers in production when no allowlist is set", () => {
    expect(isOriginAllowed("https://evil.example", [], true)).toBe(false);
  });

  it("stays permissive in development when no allowlist is set", () => {
    expect(isOriginAllowed("http://localhost:5173", [], false)).toBe(true);
  });

  it("does not treat a null origin as a native client", () => {
    // "Origin: null" is what sandboxed iframes send, so it must be opted into
    // explicitly rather than inherited from the originless rule.
    expect(isOriginAllowed("null", [], true)).toBe(false);
    expect(isOriginAllowed("null", ["null"], true)).toBe(true);
  });
});

describe("corsMiddleware", () => {
  it("serves an originless request and sends no allow-origin header", async () => {
    const res = await request(appWith({ NODE_ENV: "production" })).get("/ping");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("echoes the allow-origin header for an allowed origin", async () => {
    const res = await request(
      appWith({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://micd.example" }),
    )
      .get("/ping")
      .set("Origin", "https://micd.example");

    expect(res.headers["access-control-allow-origin"]).toBe("https://micd.example");
  });

  it("omits the allow-origin header for a disallowed origin", async () => {
    const res = await request(
      appWith({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://micd.example" }),
    )
      .get("/ping")
      .set("Origin", "https://evil.example");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reads a comma-separated allowlist", async () => {
    const app = appWith({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://a.example, https://b.example",
    });

    const a = await request(app).get("/ping").set("Origin", "https://a.example");
    const b = await request(app).get("/ping").set("Origin", "https://b.example");

    expect(a.headers["access-control-allow-origin"]).toBe("https://a.example");
    expect(b.headers["access-control-allow-origin"]).toBe("https://b.example");
  });
});
