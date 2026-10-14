import { HttpError } from "../../shared/http-error";
import { Role } from "../../shared/roles";
import { AUDIT_ACTIONS, logAction } from "../../shared/audit";
import {
  verifyPassword,
  hashPassword,
  validatePasswordStrength,
} from "./password.service";
import {
  findUserByEmail,
  findUserById,
  stampLastLogin,
  setPasswordAndActivate,
  setPassword,
} from "./user.service";
import {
  consumeInvite,
  findValidInvite,
} from "./invite.service";
import {
  issueReset,
  findValidReset,
  consumeReset,
  consumeAllResetsForUser,
} from "./password-reset.service";
import { sendPasswordReset } from "../../shared/mailer";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  getTokenExpiry,
} from "./jwt.service";
import {
  storeRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
} from "./refresh-token.service";

const INVALID_CREDENTIALS = { error: "Invalid email or password" };
const INVALID_REFRESH = { error: "Invalid or expired refresh token" };
const INVALID_INVITE = { error: "Invalid or expired invite" };
const INVALID_RESET = { error: "Invalid or expired reset code" };

// Precomputed bcrypt hash (cost 12) of an arbitrary string, compared against
// on the unknown-email path so it costs the same ~bcrypt-round time as a real
// password check — otherwise an unknown email returns near-instantly while a
// wrong password on a real account pays the full bcrypt cost, letting a
// client infer which accounts exist purely from response timing.
const DUMMY_HASH =
  "$2b$12$enAnZVED6/IYN68Ss0XcnO5DM93iOCRmA8EJRtyB15nbkTf2xB9uS";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  user: { id: number; email: string; role: Role };
}

/** Verify credentials and mint a fresh access/refresh token pair. */
export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const user = await findUserByEmail(email);
  const passwordOk = await verifyPassword(
    password,
    user?.password ?? DUMMY_HASH,
  );
  // Same generic error whether the email is unknown or the password is wrong —
  // don't let a client distinguish which one failed.
  if (!user || !passwordOk) {
    throw new HttpError(401, INVALID_CREDENTIALS);
  }
  // A blocked or soft-deleted account is refused with the SAME generic error,
  // so login never discloses that an account exists but is disabled.
  if (user.status === "blocked" || user.status === "deleted") {
    throw new HttpError(401, INVALID_CREDENTIALS);
  }

  await stampLastLogin(user.id);

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });
  const refreshToken = signRefreshToken({ sub: user.id });
  await storeRefreshToken(user.id, refreshToken, getTokenExpiry(refreshToken));

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

/** Rotate a refresh token: consume the old one atomically, issue a new pair. */
export async function refresh(refreshToken: string): Promise<AuthTokens> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new HttpError(401, INVALID_REFRESH);
  }

  // Atomically revokes the token iff it was still valid — closes the race
  // where two concurrent refreshes with the same token could otherwise both
  // succeed (see consumeRefreshToken's doc comment).
  const consumed = await consumeRefreshToken(refreshToken);
  if (!consumed) {
    throw new HttpError(401, INVALID_REFRESH);
  }

  const user = await findUserById(payload.sub);
  if (!user) {
    throw new HttpError(401, INVALID_REFRESH);
  }

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });
  const newRefreshToken = signRefreshToken({ sub: user.id });
  await storeRefreshToken(
    user.id,
    newRefreshToken,
    getTokenExpiry(newRefreshToken),
  );

  return { accessToken, refreshToken: newRefreshToken };
}

/** Revoke a refresh token so it can no longer be used to refresh. */
export async function logout(refreshToken: string): Promise<void> {
  await revokeRefreshToken(refreshToken);
}

/** The email an invite code belongs to, so the accept-invite UI can name it. */
export async function getInviteEmail(code: string): Promise<{ email: string }> {
  const info = await findValidInvite(code);
  if (!info) throw new HttpError(404, INVALID_INVITE);
  return { email: info.email };
}

/**
 * Redeem an invite: consume the code atomically, set the invitee's password,
 * activate the account, and drop them straight into a logged-in session. Same
 * generic error whether the code is unknown, expired or already used.
 */
export async function acceptInvite(
  code: string,
  password: string,
  ip: string,
): Promise<LoginResult> {
  validatePasswordStrength(password);

  const userId = await consumeInvite(code);
  if (userId === null) throw new HttpError(400, INVALID_INVITE);

  await setPasswordAndActivate(userId, await hashPassword(password));

  const user = await findUserById(userId);
  if (!user) throw new HttpError(400, INVALID_INVITE);

  await stampLastLogin(user.id);
  await logAction({
    userId: user.id,
    action: AUDIT_ACTIONS.INVITE_REDEEMED,
    resourceId: String(user.id),
    ip,
  });

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });
  const refreshToken = signRefreshToken({ sub: user.id });
  await storeRefreshToken(user.id, refreshToken, getTokenExpiry(refreshToken));

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

/**
 * Start a password reset for `email`. Silently does nothing for an unknown,
 * invited (no password yet), blocked or deleted account, or while the
 * per-account cooldown is running — the caller answers the same way regardless,
 * so this never discloses whether an account exists.
 */
export async function requestPasswordReset(
  email: string,
  locale: "es" | "en",
  ip: string,
): Promise<void> {
  const user = await findUserByEmail(email.trim());
  if (!user || user.status !== "active" || !user.password) return;

  const code = await issueReset(user.id);
  if (!code) return;

  await logAction({
    userId: user.id,
    action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
    resourceId: String(user.id),
    ip,
  });
  await sendPasswordReset(user.email, code, locale);
}

/** The email a reset code belongs to, so the reset UI can name the account. */
export async function getResetEmail(code: string): Promise<{ email: string }> {
  const info = await findValidReset(code);
  if (!info) throw new HttpError(404, INVALID_RESET);
  return { email: info.email };
}

/**
 * Redeem a reset code: consume it atomically, set the new password, then end
 * every other session (all refresh tokens) and invalidate any other outstanding
 * code, and hand back a fresh session. A user blocked or deleted after asking
 * for the code is refused with the same generic error.
 */
export async function resetPassword(
  code: string,
  password: string,
  ip: string,
): Promise<LoginResult> {
  validatePasswordStrength(password);

  const userId = await consumeReset(code);
  if (userId === null) throw new HttpError(400, INVALID_RESET);

  const user = await findUserById(userId);
  if (!user || user.status !== "active") throw new HttpError(400, INVALID_RESET);

  await setPassword(user.id, await hashPassword(password));
  await revokeAllRefreshTokensForUser(user.id);
  await consumeAllResetsForUser(user.id);

  await stampLastLogin(user.id);
  await logAction({
    userId: user.id,
    action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
    resourceId: String(user.id),
    ip,
  });

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });
  const refreshToken = signRefreshToken({ sub: user.id });
  await storeRefreshToken(user.id, refreshToken, getTokenExpiry(refreshToken));

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  };
}
