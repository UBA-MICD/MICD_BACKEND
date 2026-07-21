import rateLimit from "express-rate-limit";

/**
 * More than 5 failed attempts from the same IP blocks that IP for 15 minutes.
 * Successful logins don't count against the limit. Keys on req.ip, which is the
 * real client IP because app.set("trust proxy", 1) is configured in app.ts.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});
