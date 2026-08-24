import rateLimit from "express-rate-limit";
import { rateLimitConfig } from "../config/env";

/**
 * All budgets are per IP, keyed on req.ip — which is only meaningful if
 * "trust proxy" matches the deployment. See config/env.ts: a wrongly trusted
 * hop lets a client forge X-Forwarded-For and sidestep every limiter here.
 */
const base = {
  windowMs: rateLimitConfig.windowMs,
  standardHeaders: true,
  legacyHeaders: false,
};

/**
 * More than a handful of failed attempts from the same IP blocks that IP for
 * the window. Successful logins don't count, so a legitimate user is never
 * locked out by their own activity.
 */
export const loginRateLimiter = rateLimit({
  ...base,
  limit: rateLimitConfig.loginMax,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Try again later." },
});

/**
 * Rate limiter for the public invite endpoints (validate + accept). Separate
 * from the login limiter so a burst of invite lookups can't lock out logins,
 * and vice versa. A little more generous than login (a legit user may reload
 * the accept page), and it counts every request — a valid redeem is one-shot.
 */
export const inviteRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

/**
 * Refresh takes an unguessable token, but it was previously the one auth route
 * with no ceiling at all — leaving a free oracle to grind tokens against and an
 * unbounded way to force bcrypt-free DB work. The budget is well above what a
 * real client needs (access tokens last 15 minutes, so a normal session
 * refreshes a handful of times per window).
 */
export const refreshRateLimiter = rateLimit({
  ...base,
  limit: rateLimitConfig.refreshMax,
  message: { error: "Too many refresh attempts. Try again later." },
});

/**
* Uploads are the most expensive route: each one buffers a file in memory and
* pushes it to Orthanc. The budget has to clear a bulk seed run from a single
* IP, so it bounds runaway clients rather than shaping normal use.
*/
export const uploadRateLimiter = rateLimit({
 ...base,
 limit: rateLimitConfig.uploadMax,
 message: { error: "Too many uploads. Try again later." },
});

/**
 * Backstop for every other route. Liveness/readiness probes are exempt: the
 * container healthcheck polls them continuously, and letting a traffic spike
 * exhaust the shared budget would turn into 429s on the probe and get the
 * container restarted — turning a load problem into an outage.
 */
export const globalRateLimiter = rateLimit({
  ...base,
  limit: rateLimitConfig.globalMax,
  skip: (req) => req.path === "/api/livez" || req.path === "/api/readyz",
  message: { error: "Too many requests. Try again later." },
});
