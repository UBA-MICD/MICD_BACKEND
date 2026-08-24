import { Router } from "express";
import {
  loginRateLimiter,
  inviteRateLimiter,
  refreshRateLimiter,
} from "../../middleware/rate-limit.middleware";
import {
  loginHandler,
  refreshHandler,
  logoutHandler,
  getInviteHandler,
  acceptInviteHandler,
} from "./auth.controller";

/** Routes mounted at /auth. All are public (they mint or clear tokens). */
export const authRouter = Router();

authRouter.post("/login", loginRateLimiter, loginHandler);
authRouter.post("/refresh", refreshRateLimiter, refreshHandler);
authRouter.post("/logout", logoutHandler);

// Invite redemption (US-H04): validate a code, then set a password and log in.
authRouter.get("/invite/:code", inviteRateLimiter, getInviteHandler);
authRouter.post("/accept-invite", inviteRateLimiter, acceptInviteHandler);
