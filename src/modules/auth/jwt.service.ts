import jwt, { SignOptions } from "jsonwebtoken";
import { randomUUID } from "crypto";
import { jwtConfig } from "../../config/env";

export interface AccessTokenPayload {
  sub: number;
  email: string;
}

export interface RefreshTokenPayload {
  sub: number;
  jti: string;
}

export function signAccessToken(
  payload: AccessTokenPayload,
  options: SignOptions = {},
): string {
  return jwt.sign(payload, jwtConfig.accessSecret, {
    expiresIn: jwtConfig.accessTtl,
    ...options,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(
    token,
    jwtConfig.accessSecret,
  ) as unknown as AccessTokenPayload;
}

export function signRefreshToken(
  payload: { sub: number },
  options: SignOptions = {},
): string {
  return jwt.sign({ sub: payload.sub, jti: randomUUID() }, jwtConfig.refreshSecret, {
    expiresIn: jwtConfig.refreshTtl,
    ...options,
  } as SignOptions);
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(
    token,
    jwtConfig.refreshSecret,
  ) as unknown as RefreshTokenPayload;
}

/** Reads the `exp` claim off an already-signed token without verifying it. */
export function getTokenExpiry(token: string): Date {
  const decoded = jwt.decode(token) as { exp: number };
  return new Date(decoded.exp * 1000);
}
