import { RequestHandler } from "express";
import {
  verifyAccessToken,
  AccessTokenPayload,
} from "../modules/auth/jwt.service";
import { HttpError } from "../shared/http-error";
import { Role, isRole } from "../shared/roles";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

/** Gate a route behind a valid Bearer access token; attaches req.user. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = header.slice("Bearer ".length);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      res.status(401).json({ error: "Token expired" });
    } else {
      res.status(401).json({ error: "Invalid token" });
    }
  }
};

/** A requireRole guard, with its allowed roles readable for introspection. */
export type RoleGuard = RequestHandler & { roles: Role[] };

/**
 * Gate a route behind one of `roles`. Must run after {@link requireAuth}, which
 * populates req.user.
 *
 * - Missing or invalid role claim → **401** (not 403). A token minted before
 *   this feature deployed carries no role; answering 401 lets the web client's
 *   authFetch silently refresh + retry, so the deploy self-heals instead of
 *   403-ing every logged-in user for the ~15-minute access-token lifetime.
 * - Authenticated but wrong role → **403** via HttpError, handled by the global
 *   error handler in app.ts.
 *
 * The allowed roles are exposed as `guard.roles` so a route-matrix test can walk
 * `router.stack` and assert each route's authorization.
 */
export const requireRole = (...roles: Role[]): RoleGuard => {
  const guard: RequestHandler = (req, res, next) => {
    const role = req.user?.role;
    if (!req.user || !isRole(role)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(role)) {
      next(
        new HttpError(403, {
          error: "Forbidden",
          detail: `Requires role: ${roles.join(", ")}`,
        }),
      );
      return;
    }
    next();
  };
  return Object.assign(guard, { roles });
};
