import { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { verifyPassword } from "./services/password.service";
import { findUserByEmail, findUserById } from "./services/user.service";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  getTokenExpiry,
} from "./services/jwt.service";
import {
  storeRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
} from "./services/refresh-token.service";

// More than 5 failed attempts from the same IP blocks that IP for 15 minutes.
// Successful logins don't count against the limit.
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const INVALID_CREDENTIALS = { error: "Invalid email or password" };

// Precomputed bcrypt hash (cost 12) of an arbitrary string, compared against
// on the unknown-email path so it costs the same ~bcrypt-round time as a real
// password check — otherwise an unknown email returns near-instantly while a
// wrong password on a real account pays the full bcrypt cost, letting a
// client infer which accounts exist purely from response timing.
const DUMMY_HASH =
  "$2b$12$enAnZVED6/IYN68Ss0XcnO5DM93iOCRmA8EJRtyB15nbkTf2xB9uS";

export const loginHandler: RequestHandler = async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const user = await findUserByEmail(email);
  const passwordOk = await verifyPassword(
    password,
    user?.password_hash ?? DUMMY_HASH,
  );
  // Same generic response whether the email is unknown or the password is
  // wrong — don't let a client distinguish which one failed.
  if (!user || !passwordOk) {
    res.status(401).json(INVALID_CREDENTIALS);
    return;
  }

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
  });
  const refreshToken = signRefreshToken({ sub: user.id });
  await storeRefreshToken(user.id, refreshToken, getTokenExpiry(refreshToken));

  res.status(200).json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  });
};

export const refreshHandler: RequestHandler = async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== "string") {
    res.status(400).json({ error: "refreshToken is required" });
    return;
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  // Atomically revokes the token iff it was still valid — closes the race
  // where two concurrent refreshes with the same token could otherwise both
  // succeed (see consumeRefreshToken's doc comment).
  const consumed = await consumeRefreshToken(refreshToken);
  if (!consumed) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const user = await findUserById(payload.sub);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const newAccessToken = signAccessToken({
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

  res.status(200).json({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  });
};

export const logoutHandler: RequestHandler = async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken === "string") {
    await revokeRefreshToken(refreshToken);
  }
  res.status(204).send();
};
