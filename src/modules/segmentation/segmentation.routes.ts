import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { segmentationRateLimiter } from "../../middleware/rate-limit.middleware";
import * as ctrl from "./segmentation.controller";

/**
 * AI segmentation routes, mounted at `/api/v1/ml` in app.ts.
 *
 * Running a segmentation and reading a candidate's history are read-side aids on
 * an image the user can already see — open to every role that can view studies
 * (not informatico, which only uploads/downloads).
 * Correcting, accepting or discarding a candidate is a clinical write ("el
 * validador"), so those are gated to medico/admin, matching study validation.
 */
export const segmentationRouter = Router();

segmentationRouter.post(
  "/segmentation",
  requireAuth,
  requireRole("admin", "medico", "investigador"),
  segmentationRateLimiter,
  ctrl.segmentImage,
);

segmentationRouter.get(
  "/segmentation",
  requireAuth,
  requireRole("admin", "medico", "investigador"),
  ctrl.getSegmentationForInstance,
);

segmentationRouter.get(
  "/segmentation/:id/corrections",
  requireAuth,
  requireRole("admin", "medico", "investigador"),
  ctrl.getSegmentationHistory,
);

segmentationRouter.get(
  "/segmentation/:id",
  requireAuth,
  requireRole("admin", "medico", "investigador"),
  ctrl.getSegmentationById,
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
