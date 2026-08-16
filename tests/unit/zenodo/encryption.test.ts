import { encrypt, decrypt } from "../../../src/shared/encryption";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64); // 32 bytes, hex-encoded
});

describe("encryption", () => {
  it("encrypt → decrypt returns the original string", () => {
    const original = "my-secret-zenodo-token";
    const encrypted = encrypt(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it("two encrypt() calls on the same string produce different ciphertext (random IV)", () => {
    const a = encrypt("same-input");
    const b = encrypt("same-input");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same-input");
    expect(decrypt(b)).toBe("same-input");
  });
});
