import { Router } from "express";
import { livezHandler, readyzHandler } from "./health.controller";

/**
 * Mounted at /api → exposes the public liveness/readiness probes:
 *  - GET /api/livez  — process alive, no dependency checks (restart signal)
 *  - GET /api/readyz — Postgres + Orthanc reachable (traffic-routing signal)
 *  - GET /api/health — back-compat alias of /api/readyz for existing callers
 */
export const healthRouter = Router();

healthRouter.get("/livez", livezHandler);
healthRouter.get("/readyz", readyzHandler);
healthRouter.get("/health", readyzHandler);
