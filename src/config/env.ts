/**
 * Central environment configuration.
 *
 * Every module reads its settings from here instead of touching process.env
 * directly, so the full set of knobs (and their defaults) lives in one place
 * and can be validated at startup.
 */

/**
 * How many reverse-proxy hops may be trusted to set X-Forwarded-For.
 *
 * This is a security control, not a convenience knob: req.ip is derived from
 * that header for every trusted hop, and the login rate limiter keys on req.ip.
 * Trust a hop that isn't really there and a client can supply its own
 * X-Forwarded-For, present a different IP on every request, and never reach the
 * limit. Behind the `web` repo's nginx the answer is 1; when the API is reached
 * directly — the desktop app, or any published port with no proxy in front — it
 * must be 0.
 *
 * Unparseable values fall back to 1 rather than to "trust everything".
 */
function parseTrustProxy(raw: string | undefined): number | false {
  if (raw === undefined) return 1;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  const hops = parseInt(raw, 10);
  return Number.isNaN(hops) || hops < 0 ? 1 : hops;
}

export const serverConfig = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  // Interface to bind, or undefined to let Node choose.
  //
  // Undefined is deliberately the default and is NOT the same as "0.0.0.0":
  // with no host Node binds dual-stack (IPv6 :: plus mapped IPv4), whereas an
  // explicit 0.0.0.0 binds IPv4 only and refuses connections to ::1 — which is
  // what `localhost` resolves to first in the container, so healthchecks fail.
  // A desktop install bundling its own backend should set HOST=127.0.0.1:
  // otherwise the API — and through it the PACS behind it — is reachable by
  // anyone on the same network as the laptop.
  host: process.env.HOST || undefined,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};

// TLS is opt-in: unset/anything but the literal "true" keeps the server on
// plain HTTP (e.g. behind a reverse proxy that already terminates TLS).
export const tlsConfig = {
  enabled: process.env.TLS_ENABLED === "true",
  certPath: process.env.TLS_CERT_PATH,
  keyPath: process.env.TLS_KEY_PATH,
};

// Comma-separated allowlist of browser origins permitted to call this API
// cross-origin. Empty means "no allowlist configured" — see cors.middleware.ts
// for what that falls back to. Native clients (the desktop app, the seeder)
// send no Origin at all and are unaffected by this.
export const corsConfig = {
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
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

/**
 * Rate-limit budgets, all per IP per window.
 *
 * These are sized for the desktop deployment, where the entire application is
 * one user behind a single (loopback) address doing bursty bulk work — a seed
 * run uploads hundreds of DICOMs back to back, and every one of them keys to
 * the same bucket. The upload and global budgets are therefore deliberately
 * generous: they exist to bound abuse, not to pace a legitimate client. Login
 * stays tight because credential stuffing is the actual threat on that route.
 */
export const rateLimitConfig = {
  windowMs: parseInt(
    process.env.RATE_LIMIT_WINDOW_MS ?? String(15 * 60 * 1000),
    10,
  ),
  loginMax: parseInt(process.env.RATE_LIMIT_LOGIN_MAX ?? "5", 10),
  refreshMax: parseInt(process.env.RATE_LIMIT_REFRESH_MAX ?? "60", 10),
  inviteMax: parseInt(process.env.RATE_LIMIT_INVITE_MAX ?? "20", 10),
  passwordResetMax: parseInt(
    process.env.RATE_LIMIT_PASSWORD_RESET_MAX ?? "10",
    10,
  ),
  uploadMax: parseInt(process.env.RATE_LIMIT_UPLOAD_MAX ?? "1000", 10),
  globalMax: parseInt(process.env.RATE_LIMIT_GLOBAL_MAX ?? "3000", 10),
};

// Ceiling for a single DICOM upload, enforced in two places: multer aborts the
// stream once a request exceeds it (so an oversized body is never buffered into
// memory) and the upload service re-checks the buffer it ends up with.
export const uploadConfig = {
  maxFileBytes: parseInt(
    process.env.MAX_UPLOAD_BYTES ?? String(500 * 1024 * 1024),
    10,
  ),
};

// ── Pre-storage PHI verification (TK-11) ──────────────────────────────────────
// How the upload pipeline reacts when the independent tag check finds residual
// PHI on an instance Orthanc just stored:
//   strict (default) — reject it: delete it from Orthanc and store nothing.
//   warn             — store it, but flag the study needs_review.
// Validated here so a typo'd value fails startup loudly instead of silently
// falling back to a weaker mode than the operator intended.
export type AnonymizationVerifyMode = "strict" | "warn";

function parseVerifyMode(raw: string | undefined): AnonymizationVerifyMode {
  const mode = (raw ?? "strict").trim().toLowerCase();
  if (mode !== "strict" && mode !== "warn") {
    throw new Error(
      `ANONYMIZATION_VERIFY_MODE must be "strict" or "warn", got "${raw}"`,
    );
  }
  return mode;
}

// Fail fast at startup (this call runs on import, before app.listen).
parseVerifyMode(process.env.ANONYMIZATION_VERIFY_MODE);

export const anonymizationConfig = {
  // Lazy getter so tests can set the mode at runtime; it re-validates on every
  // read, so an invalid value can never slip through as a silent default.
  get verifyMode(): AnonymizationVerifyMode {
    return parseVerifyMode(process.env.ANONYMIZATION_VERIFY_MODE);
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
