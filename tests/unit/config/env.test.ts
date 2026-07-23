/**
 * env.ts reads process.env at import time (and its production guard throws
 * during import), so every case re-imports a fresh copy of the module with
 * jest.resetModules() after shaping process.env.
 */

const ENV_KEYS = [
  "PORT",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "ORTHANC_URL",
  "ORTHANC_USERNAME",
  "ORTHANC_PASSWORD",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "JWT_ACCESS_TTL",
  "JWT_REFRESH_TTL",
  "BCRYPT_ROUNDS",
  "NODE_ENV",
] as const;

type EnvOverrides = Partial<Record<(typeof ENV_KEYS)[number], string>>;

const ORIGINAL_ENV = { ...process.env };

/** Clear all config-related vars, apply overrides, and import a fresh env.ts. */
function loadEnv(overrides: EnvOverrides = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../../src/config/env") as typeof import("../../../src/config/env");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("config/env — defaults", () => {
  it("uses documented defaults when no env vars are set", () => {
    const env = loadEnv();
    expect(env.serverConfig).toEqual({ port: 3000 });
    expect(env.dbConfig).toEqual({
      host: "postgres",
      port: 5432,
      database: "micd",
      user: "micd",
      password: "micd",
    });
    expect(env.orthancConfig.url).toBe("http://orthanc:8042");
    expect(env.jwtConfig).toEqual({
      accessSecret: "change-me-access-secret",
      refreshSecret: "change-me-refresh-secret",
      accessTtl: "15m",
      refreshTtl: "7d",
    });
    expect(env.bcryptRounds).toBe(12);
  });

  it("mirrors the Orthanc credentials into the axios-style auth object", () => {
    const env = loadEnv();
    expect(env.orthancConfig.auth).toEqual({
      username: env.orthancConfig.username,
      password: env.orthancConfig.password,
    });
  });
});

describe("config/env — overrides", () => {
  it("reads every knob from process.env when set", () => {
    const env = loadEnv({
      PORT: "8080",
      DB_HOST: "db.internal",
      DB_PORT: "6543",
      DB_NAME: "micd_test",
      DB_USER: "app",
      DB_PASSWORD: "s3cret",
      ORTHANC_URL: "http://pacs:9999",
      ORTHANC_USERNAME: "admin",
      ORTHANC_PASSWORD: "hunter2",
      JWT_SECRET: "real-access",
      JWT_REFRESH_SECRET: "real-refresh",
      JWT_ACCESS_TTL: "5m",
      JWT_REFRESH_TTL: "1d",
      BCRYPT_ROUNDS: "4",
    });
    expect(env.serverConfig.port).toBe(8080);
    expect(env.dbConfig).toEqual({
      host: "db.internal",
      port: 6543,
      database: "micd_test",
      user: "app",
      password: "s3cret",
    });
    expect(env.orthancConfig).toEqual({
      url: "http://pacs:9999",
      username: "admin",
      password: "hunter2",
      auth: { username: "admin", password: "hunter2" },
    });
    expect(env.jwtConfig).toEqual({
      accessSecret: "real-access",
      refreshSecret: "real-refresh",
      accessTtl: "5m",
      refreshTtl: "1d",
    });
    expect(env.bcryptRounds).toBe(4);
  });

  it("parses numeric knobs as base-10 integers", () => {
    const env = loadEnv({ PORT: "0080", BCRYPT_ROUNDS: "010" });
    expect(env.serverConfig.port).toBe(80);
    expect(env.bcryptRounds).toBe(10);
  });
});

describe("config/env — production JWT-secret guard", () => {
  const PLACEHOLDER_ACCESS = "change-me-access-secret";
  const PLACEHOLDER_REFRESH = "change-me-refresh-secret";

  it("throws in production when both secrets are left at the placeholders", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(
      /JWT_SECRET\/JWT_REFRESH_SECRET must be set/,
    );
  });

  it("throws in production when only the access secret is a placeholder", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        JWT_SECRET: PLACEHOLDER_ACCESS,
        JWT_REFRESH_SECRET: "real-refresh",
      }),
    ).toThrow();
  });

  it("throws in production when only the refresh secret is a placeholder", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        JWT_SECRET: "real-access",
        JWT_REFRESH_SECRET: PLACEHOLDER_REFRESH,
      }),
    ).toThrow();
  });

  it("does not throw in production when both secrets are real", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      JWT_SECRET: "real-access",
      JWT_REFRESH_SECRET: "real-refresh",
    });
    expect(env.jwtConfig.accessSecret).toBe("real-access");
    expect(env.jwtConfig.refreshSecret).toBe("real-refresh");
  });

  it("tolerates placeholder secrets outside production", () => {
    const env = loadEnv({ NODE_ENV: "development" });
    expect(env.jwtConfig.accessSecret).toBe(PLACEHOLDER_ACCESS);
    expect(env.jwtConfig.refreshSecret).toBe(PLACEHOLDER_REFRESH);
  });
});
