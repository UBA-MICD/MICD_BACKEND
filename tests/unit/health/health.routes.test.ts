import { healthRouter } from "../../../src/modules/health/health.routes";
import { livezHandler, readyzHandler } from "../../../src/modules/health/health.controller";

/**
 * Router-stack introspection instead of supertest: this repo's unit tests call
 * handlers directly (no live HTTP server in tests/unit), so we assert the
 * route table wires each path to the expected handler function reference.
 */
function handlerFor(path: string): unknown {
  const layer = healthRouter.stack.find((l: any) => l.route?.path === path);
  return layer?.route?.stack?.[0]?.handle;
}

describe("healthRouter", () => {
  it("routes GET /livez to livezHandler", () => {
    expect(handlerFor("/livez")).toBe(livezHandler);
  });

  it("routes GET /readyz to readyzHandler", () => {
    expect(handlerFor("/readyz")).toBe(readyzHandler);
  });

  it("keeps GET /health as a back-compat alias of readyzHandler", () => {
    expect(handlerFor("/health")).toBe(readyzHandler);
  });

  it("does not expose any other routes", () => {
    const paths = healthRouter.stack.map((l: any) => l.route?.path).sort();
    expect(paths).toEqual(["/health", "/livez", "/readyz"]);
  });
});
