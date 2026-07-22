import {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../../src/modules/auth/jwt.service";

const PAYLOAD = { sub: 1, email: "user@micd.local" };

describe("jwt.service — access tokens", () => {
  it("signs and verifies a valid access token", () => {
    const token = signAccessToken(PAYLOAD);
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe(PAYLOAD.sub);
    expect(decoded.email).toBe(PAYLOAD.email);
  });

  it("rejects a token signed with a different secret (tampered)", () => {
    const token = signAccessToken(PAYLOAD);
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it("rejects an expired access token", () => {
    const expired = signAccessToken(PAYLOAD, { expiresIn: "-1s" });
    expect(() => verifyAccessToken(expired)).toThrow(/expired/i);
  });
});

describe("jwt.service — refresh tokens", () => {
  it("signs and verifies a valid refresh token with a unique jti", () => {
    const a = signRefreshToken({ sub: 1 });
    const b = signRefreshToken({ sub: 1 });
    const decodedA = verifyRefreshToken(a);
    const decodedB = verifyRefreshToken(b);
    expect(decodedA.sub).toBe(1);
    expect(decodedA.jti).toBeTruthy();
    expect(decodedA.jti).not.toBe(decodedB.jti);
  });

  it("rejects an expired refresh token", () => {
    const expired = signRefreshToken({ sub: 1 }, { expiresIn: "-1s" });
    expect(() => verifyRefreshToken(expired)).toThrow(/expired/i);
  });

  it("access and refresh tokens use different secrets (cross-verification fails)", () => {
    const accessToken = signAccessToken(PAYLOAD);
    expect(() => verifyRefreshToken(accessToken)).toThrow();
  });
});
