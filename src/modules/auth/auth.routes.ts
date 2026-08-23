import { Router } from "express";
import {
  loginRateLimiter,
  refreshRateLimiter,
} from "../../middleware/rate-limit.middleware";
import { loginHandler, refreshHandler, logoutHandler } from "./auth.controller";

/** Routes mounted at /auth. All are public (they mint or clear tokens). */
export const authRouter = Router();

authRouter.post("/login", loginRateLimiter, loginHandler);
authRouter.post("/refresh", refreshRateLimiter, refreshHandler);
authRouter.post("/logout", logoutHandler);
