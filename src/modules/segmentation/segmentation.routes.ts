import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { ROLES } from "../../shared/roles";
import * as ctrl from "./segmentation.controller";

/**
 * AI segmentation routes, mounted at `/api/v1/ml` in app.ts.
 *
 * Open to every authenticated role: segmenting is a read-side aid on an image
 * the user can already see, and it persists nothing. `POST` because it runs an
 * inference and mints new UIDs — the response is not cacheable.
 */
export const segmentationRouter = Router();

segmentationRouter.post(
  "/segmentation",
  requireAuth,
  requireRole(...ROLES),
  ctrl.segmentImage,
);
