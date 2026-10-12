/**
 * Unit tests for the RBAC role vocabulary — the single source of truth in
 * src/shared/roles.ts. Pure logic, no I/O, runs under jest (npm run test:unit).
 */
import { ROLES, isRole } from "../../../src/shared/roles";

describe("ROLES", () => {
  it("is exactly the four known roles, in order", () => {
    expect(ROLES).toEqual(["admin", "medico", "investigador", "informatico"]);
  });
});

describe("isRole", () => {
  it.each(ROLES)("accepts the known role %s", (role) => {
    expect(isRole(role)).toBe(true);
  });

  it.each([
    ["unknown string", "superuser"],
    ["empty string", ""],
    ["wrong case", "Admin"],
    ["null", null],
    ["undefined", undefined],
    ["number", 1],
    ["object", { role: "admin" }],
  ])("rejects %s", (_label, value) => {
    expect(isRole(value)).toBe(false);
  });
});
