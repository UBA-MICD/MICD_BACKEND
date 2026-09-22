import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { ROLES } from "../../shared/roles";
import { listPathologies } from "./pathologies.controller";

/**
 * Pathology catalog — read-only, all authenticated roles. Mounted at
 * /api/v1/pathologies in app.ts. The client fetches this to build the upload
 * classification selector.
 */
export const pathologiesRouter = Router();

pathologiesRouter.get("/", requireAuth, requireRole(...ROLES), listPathologies);
