import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { segmentationRateLimiter } from "../../middleware/rate-limit.middleware";
import { ROLES } from "../../shared/roles";
import * as ctrl from "./segmentation.controller";

/**
 * AI segmentation routes, mounted at `/api/v1/ml` in app.ts.
 *
 * Running a segmentation and reading a candidate's history are read-side aids on
 * an image the user can already see — open to every authenticated role.
 * Correcting, accepting or discarding a candidate is a clinical write ("el
 * validador"), so those are gated to medico/admin, matching study validation.
 */
export const segmentationRouter = Router();

segmentationRouter.post(
  "/segmentation",
  requireAuth,
  requireRole(...ROLES),
  segmentationRateLimiter,
  ctrl.segmentImage,
);

segmentationRouter.get(
  "/segmentation",
  requireAuth,
  requireRole(...ROLES),
  ctrl.getSegmentationForInstance,
);

segmentationRouter.get(
  "/segmentation/:id/corrections",
  requireAuth,
  requireRole(...ROLES),
  ctrl.getSegmentationHistory,
);

segmentationRouter.post(
  "/segmentation/:id/corrections",
  requireAuth,
  requireRole("medico", "admin"),
  ctrl.saveCorrection,
);

segmentationRouter.post(
  "/segmentation/:id/accept",
  requireAuth,
  requireRole("medico", "admin"),
  ctrl.acceptSegmentation,
);

segmentationRouter.post(
  "/segmentation/:id/discard",
  requireAuth,
  requireRole("medico", "admin"),
  ctrl.discardSegmentation,
);
