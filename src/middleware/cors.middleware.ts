import cors from "cors";
import { corsConfig } from "../config/env";

/**
 * Decide whether a browser origin may call this API cross-origin.
 *
 * A request with no Origin header is always allowed. CORS is a browser-side
 * control, and the clients that send no Origin are native ones — the desktop
 * (Electron) app, the seeder, curl. Rejecting them would break the desktop
 * deployment without stopping any attacker, who can trivially omit the header
 * anyway. What CORS actually protects is a *browser* being used as a confused
 * deputy, and that always carries an Origin.
 *
 * Note that "null" is not the same as absent: sandboxed iframes on any site
 * send `Origin: null`, so it has to be opted into explicitly rather than
 * inheriting the originless rule.
 *
 * With no allowlist configured, development stays permissive (any origin) and
 * production allows only native clients. The browser client is served
 * same-origin behind nginx, so it needs no entry here; the allowlist is for a
 * frontend dev server or a genuinely cross-origin browser caller.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
  isProduction: boolean,
): boolean {
  if (origin === undefined) return true;
  if (allowedOrigins.includes(origin)) return true;
  return allowedOrigins.length === 0 && !isProduction;
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Signal "not allowed" by withholding the header rather than erroring:
    // the browser blocks the response either way, and a native client that
    // ignores CORS is not turned into a 500.
    callback(
      null,
      isOriginAllowed(
        origin,
        corsConfig.allowedOrigins,
        process.env.NODE_ENV === "production",
      ),
    );
  },
  credentials: false,
});
