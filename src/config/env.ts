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

export const bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS ?? "12", 10);

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
