import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import * as ctrl from "./studies.controller";

/**
 * Study read routes. Registered with their full paths (mounted at root in
 * app.ts) so the two API generations keep their exact URLs:
 *   - legacy `/api/studies*`  — thin Orthanc proxy
 *   - current `/api/v1/studies*` — Postgres-backed, paginated/filtered
 * Every route is gated by requireAuth.
 */
export const studiesRouter = Router();

// ── Legacy Orthanc proxy ──────────────────────────────────────────────────────
studiesRouter.get("/api/studies", requireAuth, ctrl.listOrthancStudies);
studiesRouter.get("/api/studies/:id", requireAuth, ctrl.getOrthancStudy);
studiesRouter.delete("/api/studies/:id", requireAuth, ctrl.deleteOrthancStudy);

// ── v1 (Postgres-backed) ──────────────────────────────────────────────────────
studiesRouter.get(
  "/api/v1/studies/:studyId/file",
  requireAuth,
  ctrl.getStudyFile,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/instances",
  requireAuth,
  ctrl.getStudyInstances,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/instances/:instanceId/file",
  requireAuth,
  ctrl.getInstanceFile,
);
studiesRouter.get("/api/v1/studies", requireAuth, ctrl.listStudies);
studiesRouter.get(
  "/api/v1/studies/:studyId/zenodo",
  requireAuth,
  ctrl.getStudyZenodo,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/thumbnail",
  requireAuth,
  ctrl.getStudyThumbnail,
);
