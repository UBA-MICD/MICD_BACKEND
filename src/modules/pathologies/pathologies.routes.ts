import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { listPathologies } from "./pathologies.controller";

/**
 * Pathology catalog — read-only, open to every role (informatico included, since it
 * feeds the upload form). Mounted at
 * /api/v1/pathologies in app.ts. The client fetches this to build the upload
 * classification selector.
 */
export const pathologiesRouter = Router();

pathologiesRouter.get(
  "/",
  requireAuth,
  requireRole("admin", "medico", "investigador", "informatico"),
  listPathologies,
);
