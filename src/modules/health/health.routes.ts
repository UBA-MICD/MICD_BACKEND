import { Router } from "express";
import { healthHandler } from "./health.controller";

/** Mounted at /api → exposes the public GET /api/health probe. */
export const healthRouter = Router();

healthRouter.get("/health", healthHandler);
