import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import * as ctrl from "./zenodo.controller";

/**
 * Zenodo integration routes, mounted at /api/v1/zenodo in app.ts. The original
 * implementation gated these behind an admin role; this backend has a flat
 * user model (no roles), so every route is gated by requireAuth like the rest
 * of the data routes.
 */
export const zenodoRouter = Router();

zenodoRouter.use(requireAuth);

// ── Credentials configuration (ZEN-01) ───────────────────────────────────────
zenodoRouter.post("/config", ctrl.configureToken);
zenodoRouter.get("/config/status", ctrl.getConfigStatus);
zenodoRouter.delete("/config/:environment", ctrl.removeConfig);

// ── Panel state (ZEN-02): connection health per environment ──────────────────
zenodoRouter.get("/health", ctrl.getHealth);
