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
  "TLS_ENABLED",
  "TLS_CERT_PATH",
  "TLS_KEY_PATH",
  "TRUST_PROXY",
  "HOST",
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
    expect(env.serverConfig).toEqual({
      port: 3000,
      host: undefined,
      trustProxy: 1,
    });
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
      DB_PASSWORD: "real-db-pass",
      ORTHANC_PASSWORD: "real-orthanc-pass",
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

describe("config/env — production DB/Orthanc weak-password guard", () => {
  const REAL_JWT = {
    JWT_SECRET: "real-access",
    JWT_REFRESH_SECRET: "real-refresh",
  };

  it("throws in production when DB_PASSWORD is left at the default", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        ...REAL_JWT,
        ORTHANC_PASSWORD: "real-orthanc-pass",
      }),
    ).toThrow(/DB_PASSWORD must be set to a real secret in production/);
  });

  it("throws in production when ORTHANC_PASSWORD is left at the default", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        ...REAL_JWT,
        DB_PASSWORD: "real-db-pass",
      }),
    ).toThrow(/ORTHANC_PASSWORD must be set to a real secret in production/);
  });

  it("throws in production when both DB_PASSWORD and ORTHANC_PASSWORD are left at their defaults", () => {
    expect(() => loadEnv({ NODE_ENV: "production", ...REAL_JWT })).toThrow();
  });

  it("does not throw in production when DB_PASSWORD and ORTHANC_PASSWORD are real", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      ...REAL_JWT,
      DB_PASSWORD: "real-db-pass",
      ORTHANC_PASSWORD: "real-orthanc-pass",
    });
    expect(env.dbConfig.password).toBe("real-db-pass");
    expect(env.orthancConfig.password).toBe("real-orthanc-pass");
  });

  it("tolerates default DB/Orthanc passwords outside production", () => {
    const env = loadEnv({ NODE_ENV: "development" });
    expect(env.dbConfig.password).toBe("micd");
    expect(env.orthancConfig.password).toBe("orthanc");
  });
});

describe("config/env — TLS", () => {
  it("defaults to TLS disabled with no cert/key paths", () => {
    const env = loadEnv();
    expect(env.tlsConfig).toEqual({
      enabled: false,
      certPath: undefined,
      keyPath: undefined,
    });
  });

  it('enables TLS only when TLS_ENABLED is exactly "true"', () => {
    expect(loadEnv({ TLS_ENABLED: "1" }).tlsConfig.enabled).toBe(false);
    expect(loadEnv({ TLS_ENABLED: "false" }).tlsConfig.enabled).toBe(false);
    expect(loadEnv({ TLS_ENABLED: "TRUE" }).tlsConfig.enabled).toBe(false);
    expect(loadEnv({ TLS_ENABLED: "true" }).tlsConfig.enabled).toBe(true);
  });

  it("reads cert/key paths from the environment", () => {
    const env = loadEnv({
      TLS_ENABLED: "true",
      TLS_CERT_PATH: "/certs/tls.crt",
      TLS_KEY_PATH: "/certs/tls.key",
    });
    expect(env.tlsConfig).toEqual({
      enabled: true,
      certPath: "/certs/tls.crt",
      keyPath: "/certs/tls.key",
    });
  });
});

/**
 * TRUST_PROXY decides how many forwarding hops may set X-Forwarded-For, and the
 * login rate limiter keys on the req.ip that results — every trusted hop is one
 * a client can forge past. It has to be 0 wherever the API is reached directly,
 * which is the desktop app's case.
 */
describe("config/env — trust proxy", () => {
  it("trusts a single hop by default, matching the nginx deployment", () => {
    expect(loadEnv().serverConfig.trustProxy).toBe(1);
  });

  it.each(["0", "false", "FALSE"])(
    "disables proxy trust entirely for TRUST_PROXY=%j",
    (value) => {
      expect(loadEnv({ TRUST_PROXY: value }).serverConfig.trustProxy).toBe(false);
    },
  );

  it("accepts an explicit hop count", () => {
    expect(loadEnv({ TRUST_PROXY: "2" }).serverConfig.trustProxy).toBe(2);
  });

  it("falls back to one hop for an unparseable value", () => {
    expect(loadEnv({ TRUST_PROXY: "yes" }).serverConfig.trustProxy).toBe(1);
    expect(loadEnv({ TRUST_PROXY: "-3" }).serverConfig.trustProxy).toBe(1);
  });
});

/**
 * HOST is the interface the API binds to. The default publishes on all
 * interfaces, which is what the Docker deployment needs; a desktop install
 * bundling its own backend should bind loopback so the local API is not exposed
 * to whatever network the machine is on.
 */
describe("config/env — bind address", () => {
  it("leaves the bind address to Node by default", () => {
    // Not "0.0.0.0": with no host Node binds dual-stack, while an explicit
    // 0.0.0.0 is IPv4-only and refuses ::1 — which is what `localhost`
    // resolves to first, breaking container healthchecks.
    expect(loadEnv().serverConfig.host).toBeUndefined();
  });

  it("treats an empty HOST as unset rather than as a bind address", () => {
    expect(loadEnv({ HOST: "" }).serverConfig.host).toBeUndefined();
  });

  it("binds loopback when HOST is set to it", () => {
    expect(loadEnv({ HOST: "127.0.0.1" }).serverConfig.host).toBe("127.0.0.1");
  });
});
