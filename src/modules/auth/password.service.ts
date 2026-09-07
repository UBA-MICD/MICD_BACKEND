import bcrypt from "bcryptjs";
import { bcryptRounds } from "../../config/env";
import { HttpError } from "../../shared/http-error";

/** Minimum acceptable password length (the single strength rule). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The one place password strength is enforced — reused by the accept-invite
 * flow (and any future set-password path). Throws HttpError(400) on failure.
 */
export function validatePasswordStrength(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, {
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, bcryptRounds);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
