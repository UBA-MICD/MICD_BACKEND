import { encryptionConfig, zenodoTimeouts, zenodoQuota } from "../../../src/config/env";

const KEYS = [
  "ENCRYPTION_KEY",
  "ZENODO_TIMEOUT_MS",
  "ZENODO_UPLOAD_TIMEOUT_MS",
  "ZENODO_QUOTA_LIMIT_GB",
] as const;

const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe("config/env — zenodo lazy getters", () => {
  it("uses documented defaults when the vars are unset", () => {
    for (const k of KEYS) delete process.env[k];

    expect(encryptionConfig.keyHex).toBeUndefined();
    expect(zenodoTimeouts.requestMs).toBe(10000);
    expect(zenodoTimeouts.uploadMs).toBe(1800000);
    expect(zenodoQuota.limitGb).toBe(50);
  });

  it("re-reads process.env on every access (lazy, not captured at import)", () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.ZENODO_TIMEOUT_MS = "2500";
    process.env.ZENODO_UPLOAD_TIMEOUT_MS = "60000";
    process.env.ZENODO_QUOTA_LIMIT_GB = "100";

    expect(encryptionConfig.keyHex).toBe("a".repeat(64));
    expect(zenodoTimeouts.requestMs).toBe(2500);
    expect(zenodoTimeouts.uploadMs).toBe(60000);
    expect(zenodoQuota.limitGb).toBe(100);

    process.env.ZENODO_TIMEOUT_MS = "9999";
    expect(zenodoTimeouts.requestMs).toBe(9999);
  });
});
