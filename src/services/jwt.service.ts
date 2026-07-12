import jwt, { SignOptions } from "jsonwebtoken";
import { randomUUID } from "crypto";

const ACCESS_SECRET = process.env.JWT_SECRET ?? "change-me-access-secret";
const REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? "change-me-refresh-secret";
const ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? "15m";
const REFRESH_TTL = process.env.JWT_REFRESH_TTL ?? "7d";

if (
  process.env.NODE_ENV === "production" &&
  (ACCESS_SECRET === "change-me-access-secret" ||
    REFRESH_SECRET === "change-me-refresh-secret")
) {
  throw new Error(
    "JWT_SECRET/JWT_REFRESH_SECRET must be set to real secrets in production",
  );
}

export interface AccessTokenPayload {
  sub: number;
  email: string;
  role: "admin" | "user";
}

export interface RefreshTokenPayload {
  sub: number;
  jti: string;
}

export function signAccessToken(
  payload: AccessTokenPayload,
  options: SignOptions = {},
): string {
  return jwt.sign(payload, ACCESS_SECRET, {
    expiresIn: ACCESS_TTL,
    ...options,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as unknown as AccessTokenPayload;
}

export function signRefreshToken(
  payload: { sub: number },
  options: SignOptions = {},
): string {
  return jwt.sign({ sub: payload.sub, jti: randomUUID() }, REFRESH_SECRET, {
    expiresIn: REFRESH_TTL,
    ...options,
  } as SignOptions);
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, REFRESH_SECRET) as unknown as RefreshTokenPayload;
}

/** Reads the `exp` claim off an already-signed token without verifying it. */
export function getTokenExpiry(token: string): Date {
  const decoded = jwt.decode(token) as { exp: number };
  return new Date(decoded.exp * 1000);
}
