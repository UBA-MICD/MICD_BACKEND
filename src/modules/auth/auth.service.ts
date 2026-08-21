import { HttpError } from "../../shared/http-error";
import { Role } from "../../shared/roles";
import { verifyPassword } from "./password.service";
import { findUserByEmail, findUserById } from "./user.service";
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
} from "./refresh-token.service";

const INVALID_CREDENTIALS = { error: "Invalid email or password" };
const INVALID_REFRESH = { error: "Invalid or expired refresh token" };

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
