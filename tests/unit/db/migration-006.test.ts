/**
 * Unit tests for migration 006's statement builder — the env-conditional admin
 * seed. Pure logic (no DB): asserts the seed is appended only when both
 * ADMIN_EMAIL and ADMIN_PASSWORD are present, and that the password is bound as
 * a parameter rather than interpolated into SQL. The DDL itself is exercised by
 * the integration stack.
 */
import { buildRolesMigrationStatements } from "../../../src/db/migrations/006_roles";

describe("buildRolesMigrationStatements", () => {
  const saved = {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    name: process.env.ADMIN_NAME,
  };

  afterEach(() => {
    process.env.ADMIN_EMAIL = saved.email;
    process.env.ADMIN_PASSWORD = saved.password;
    process.env.ADMIN_NAME = saved.name;
  });

  const clear = () => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_NAME;
  };

  it("emits only the DDL when no admin credentials are set (CI-safe)", () => {
    clear();
    const stmts = buildRolesMigrationStatements();
    expect(stmts).toHaveLength(1);
    expect(typeof stmts[0]).toBe("string");
    expect(stmts[0]).toContain("users_role_check");
  });

  it.each([
    ["only email", { ADMIN_EMAIL: "a@b.local" }],
    ["only password", { ADMIN_PASSWORD: "secret" }],
  ])("does not seed with %s", (_label, env) => {
    clear();
    Object.assign(process.env, env);
    expect(buildRolesMigrationStatements()).toHaveLength(1);
  });

  it("appends a parameterized admin seed when both are set", () => {
    clear();
    process.env.ADMIN_EMAIL = "admin@micd.local";
    process.env.ADMIN_PASSWORD = "s3cr3t-passphrase";

    const stmts = buildRolesMigrationStatements();
    expect(stmts).toHaveLength(2);

    const seed = stmts[1];
    expect(typeof seed).toBe("object");
    if (typeof seed === "string") throw new Error("expected parameterized seed");

    // password must be bound, never present as a literal in the SQL text
    expect(seed.text).not.toContain("s3cr3t-passphrase");
    expect(seed.text).toContain("crypt($2, gen_salt('bf', 12))");
    expect(seed.text).toContain("ON CONFLICT (email) DO NOTHING");
    expect(seed.values).toEqual([
      "admin@micd.local",
      "s3cr3t-passphrase",
      "Administrador", // default name when ADMIN_NAME unset
    ]);
  });

  it("uses ADMIN_NAME when provided", () => {
    clear();
    process.env.ADMIN_EMAIL = "admin@micd.local";
    process.env.ADMIN_PASSWORD = "pw";
    process.env.ADMIN_NAME = "Jane Admin";

    const seed = buildRolesMigrationStatements()[1];
    if (typeof seed === "string") throw new Error("expected parameterized seed");
    expect(seed.values[2]).toBe("Jane Admin");
  });
});
