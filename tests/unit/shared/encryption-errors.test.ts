import {
  encrypt,
  decrypt,
  assertEncryptionKeyConfigured,
} from "../../../src/shared/encryption";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  }
});

describe("encryption — key validation", () => {
  it("throws a helpful error when ENCRYPTION_KEY is not set", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY no está configurada/);
    expect(() => assertEncryptionKeyConfigured()).toThrow(/ENCRYPTION_KEY/);
  });

  it("throws when the key is not exactly 32 bytes of hex", () => {
    process.env.ENCRYPTION_KEY = "ab".repeat(16); // 16 bytes only
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });

  it("passes assertEncryptionKeyConfigured with a valid 32-byte key", () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    expect(() => assertEncryptionKeyConfigured()).not.toThrow();
  });

  it("decrypt also validates the key before touching the ciphertext", () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    const cipher = encrypt("payload");
    delete process.env.ENCRYPTION_KEY;
    expect(() => decrypt(cipher)).toThrow(/ENCRYPTION_KEY/);
  });
});
