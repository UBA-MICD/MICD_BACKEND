/**
 * Central environment configuration.
 *
 * Every module reads its settings from here instead of touching process.env
 * directly, so the full set of knobs (and their defaults) lives in one place
 * and can be validated at startup.
 */

export const serverConfig = {
  port: parseInt(process.env.PORT ?? "3000", 10),
};

// TLS is opt-in: unset/anything but the literal "true" keeps the server on
// plain HTTP (e.g. behind a reverse proxy that already terminates TLS).
export const tlsConfig = {
  enabled: process.env.TLS_ENABLED === "true",
  certPath: process.env.TLS_CERT_PATH,
  keyPath: process.env.TLS_KEY_PATH,
};

export const dbConfig = {
  host: process.env.DB_HOST ?? "postgres",
  port: parseInt(process.env.DB_PORT ?? "5432", 10),
  database: process.env.DB_NAME ?? "micd",
  user: process.env.DB_USER ?? "micd",
  password: process.env.DB_PASSWORD ?? "micd",
};

const orthancUrl = process.env.ORTHANC_URL ?? "http://orthanc:8042";
const orthancUsername = process.env.ORTHANC_USERNAME ?? "orthanc";
const orthancPassword = process.env.ORTHANC_PASSWORD ?? "orthanc";

export const orthancConfig = {
  url: orthancUrl,
  username: orthancUsername,
  password: orthancPassword,
  auth: { username: orthancUsername, password: orthancPassword },
};

export const jwtConfig = {
  accessSecret: process.env.JWT_SECRET ?? "change-me-access-secret",
  refreshSecret: process.env.JWT_REFRESH_SECRET ?? "change-me-refresh-secret",
  accessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
  refreshTtl: process.env.JWT_REFRESH_TTL ?? "7d",
};

// Fail fast: real secrets are mandatory in production — a deployment left on
// the placeholder values would sign forgeable tokens.
if (
  process.env.NODE_ENV === "production" &&
  (jwtConfig.accessSecret === "change-me-access-secret" ||
    jwtConfig.refreshSecret === "change-me-refresh-secret")
) {
  throw new Error(
    "JWT_SECRET/JWT_REFRESH_SECRET must be set to real secrets in production",
  );
}

// Same fail-fast for the DB and Orthanc credentials: the dev-friendly
// defaults ("micd"/"orthanc") would otherwise silently ship to production.
if (process.env.NODE_ENV === "production" && dbConfig.password === "micd") {
  throw new Error("DB_PASSWORD must be set to a real secret in production");
}
if (
  process.env.NODE_ENV === "production" &&
  orthancConfig.password === "orthanc"
) {
  throw new Error(
    "ORTHANC_PASSWORD must be set to a real secret in production",
  );
}

export const bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS ?? "12", 10);

// Outgoing mail for invites (US-H04). `enabled` is derived from SMTP_HOST: when
// it is unset the mailer logs the invite link to stdout instead of sending,
// which keeps dev, CI and the integration suite working with no mail server.
// Gate mail behavior on `enabled`, never on NODE_ENV (the test stack runs as
// production). Lazy getters so tests can set the vars at runtime.
export const smtpConfig = {
  get enabled(): boolean {
    return !!process.env.SMTP_HOST;
  },
  get host(): string | undefined {
    return process.env.SMTP_HOST;
  },
  get port(): number {
    return parseInt(process.env.SMTP_PORT ?? "587", 10);
  },
  get user(): string | undefined {
    return process.env.SMTP_USER;
  },
  get pass(): string | undefined {
    return process.env.SMTP_PASS;
  },
  get from(): string {
    return process.env.SMTP_FROM ?? "MICD <no-reply@micd.local>";
  },
};

/** Public base URL of the web app, used to build the invite link. */
export const appBaseUrl = {
  get value(): string {
    return process.env.APP_BASE_URL ?? "http://localhost:3000";
  },
};

// First-admin seed (US-21). Migration 006 seeds an admin only when BOTH email
// and password are provided, so CI — which does `cp .env.example .env` and
// leaves these unset — boots without a seeded admin. Lazy getters so the
// migration reads whatever the environment holds at run time.
export const adminSeed = {
  get email(): string | undefined {
    return process.env.ADMIN_EMAIL;
  },
  get password(): string | undefined {
    return process.env.ADMIN_PASSWORD;
  },
  get name(): string {
    return process.env.ADMIN_NAME ?? "Administrador";
  },
};

// ── Zenodo (ZEN-01) ──────────────────────────────────────────────────────────
// Lazy getters (instead of values captured at import time) so unit tests can
// set the variables at runtime, and so a missing ENCRYPTION_KEY only fails when
// a token is actually encrypted/decrypted — not at startup.
export const encryptionConfig = {
  /** 32 bytes, hex-encoded (64 hex chars). See .env.example. */
  get keyHex(): string | undefined {
    return process.env.ENCRYPTION_KEY;
  },
};

export const zenodoTimeouts = {
  /** Timeout for regular Zenodo API calls. */
  get requestMs(): number {
    return parseInt(process.env.ZENODO_TIMEOUT_MS ?? "10000", 10);
  },
  /** Timeout for large file uploads/downloads to/from Zenodo. */
  get uploadMs(): number {
    return parseInt(process.env.ZENODO_UPLOAD_TIMEOUT_MS ?? "1800000", 10); // 30 min
  },
};

export const zenodoQuota = {
  /** Storage limit compared against locally recorded published-file sizes. */
  get limitGb(): number {
    return parseInt(process.env.ZENODO_QUOTA_LIMIT_GB ?? "50", 10);
  },
};


export const orthancStorageConfig = {
  get maxMb(): number | null {
    const v = process.env.ORTHANC_MAX_STORAGE_MB;
    if (!v) return null;
    const n = parseInt(v, 10);
    return isNaN(n) || n <= 0 ? null : n;
  },
  get alertPct(): number {
    return parseInt(process.env.ORTHANC_STORAGE_ALERT_PCT ?? "85", 10);
  },
};
