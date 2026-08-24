/**
 * The login rate limiter keys on req.ip, and req.ip is only as trustworthy as
 * the "trust proxy" setting. With a hop trusted, the client controls
 * X-Forwarded-For — it can present a fresh IP per request and never reach the
 * limit. Behind nginx trusting one hop is correct; when the API is reached
 * directly, as the desktop app does, it must be off.
 *
 * These cases drive the real app (a route is mounted on it) so they pin the
 * wiring in app.ts, not a replica of it.
 */
import request from "supertest";

const ORIGINAL_ENV = { ...process.env };

/** Re-import the real app with the given TRUST_PROXY, plus a route echoing req.ip. */
function appWith(trustProxy?: string) {
  delete process.env.TRUST_PROXY;
  if (trustProxy !== undefined) process.env.TRUST_PROXY = trustProxy;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require("../../src/app");
  // app.ts ends with a catch-all 404 handler + error handler that never call
  // next(), so a route appended here would be shadowed. Splice it in just
  // before those last two layers instead.
  app.get("/__ip", (req: any, res: any) => res.json({ ip: req.ip }));
  const stack = app._router.stack;
  const ipLayer = stack.pop();
  stack.splice(stack.length - 2, 0, ipLayer);
  return app;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("app trust proxy", () => {
  it("trusts one hop by default, so nginx's X-Forwarded-For is honoured", async () => {
    const app = appWith();
    expect(app.get("trust proxy")).toBe(1);

    const res = await request(app).get("/__ip").set("X-Forwarded-For", "203.0.113.9");
    expect(res.body.ip).toBe("203.0.113.9");
  });

  it("ignores a forged X-Forwarded-For when TRUST_PROXY=0", async () => {
    const app = appWith("0");
    expect(app.get("trust proxy")).toBe(false);

    const res = await request(app).get("/__ip").set("X-Forwarded-For", "203.0.113.9");

    expect(res.body.ip).not.toBe("203.0.113.9");
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });

  it("cannot be rotated per request once proxy trust is off", async () => {
    const app = appWith("0");

    const first = await request(app).get("/__ip").set("X-Forwarded-For", "198.51.100.1");
    const second = await request(app).get("/__ip").set("X-Forwarded-For", "198.51.100.2");

    // Same key both times — which is what makes a per-IP limiter meaningful.
    expect(first.body.ip).toBe(second.body.ip);
  });

  it("applies an explicit hop count", async () => {
    expect(appWith("2").get("trust proxy")).toBe(2);
  });
});
