/**
 * Unit tests for the pure invite-code helpers (generation + hashing). The
 * DB-backed issue/find/consume logic is covered by the integration suite.
 */
import { createHash } from "crypto";
import {
  generateInviteCode,
  hashInviteCode,
} from "../../../src/modules/auth/invite.service";

describe("generateInviteCode", () => {
  it("produces a URL-safe base64url string (no +/=)", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is long enough to resist guessing (24 bytes → 32 chars)", () => {
    expect(generateInviteCode().length).toBe(32);
  });

  it("is unique across calls", () => {
    const codes = new Set(Array.from({ length: 1000 }, generateInviteCode));
    expect(codes.size).toBe(1000);
  });
});

describe("hashInviteCode", () => {
  it("returns a 64-char hex SHA-256 digest", () => {
    const hash = hashInviteCode("some-code");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update("some-code").digest("hex"));
  });

  it("is deterministic and collision-free for different codes", () => {
    expect(hashInviteCode("a")).toBe(hashInviteCode("a"));
    expect(hashInviteCode("a")).not.toBe(hashInviteCode("b"));
  });

  it("never returns the plaintext code", () => {
    const code = generateInviteCode();
    expect(hashInviteCode(code)).not.toContain(code);
  });
});
