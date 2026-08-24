import { Router } from "express";
import { livezHandler, readyzHandler, orthancStatisticsHandler } from "./health.controller";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";

/**
 * Mounted at /api → exposes the public liveness/readiness probes:
 *  - GET /api/livez  — process alive, no dependency checks (restart signal)
 *  - GET /api/readyz — Postgres + Orthanc reachable (traffic-routing signal)
 *  - GET /api/health — back-compat alias of /api/readyz for existing callers
 *  - GET /api/v1/orthanc/statistics — Orthanc disk usage (admin only)
 */
export const healthRouter = Router();

healthRouter.get("/livez", livezHandler);
healthRouter.get("/readyz", readyzHandler);
healthRouter.get("/health", readyzHandler);
healthRouter.get("/v1/orthanc/statistics", requireAuth, requireRole("admin"), orthancStatisticsHandler);
