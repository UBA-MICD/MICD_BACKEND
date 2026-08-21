import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { ROLES } from "../../shared/roles";
import * as ctrl from "./studies.controller";

/**
 * Study read routes. Registered with their full paths (mounted at root in
 * app.ts) so the two API generations keep their exact URLs:
 *   - legacy `/api/studies*`  — thin Orthanc proxy
 *   - current `/api/v1/studies*` — Postgres-backed, paginated/filtered
 *
 * Every route requires a valid token (requireAuth) plus a permitted role
 * (requireRole). Reads are open to all three roles — investigador sees the same
 * studies with PHI redacted (metadata) or anonymized (files); deletes are
 * admin-only; the outward-facing Zenodo publish-check excludes investigador.
 */
export const studiesRouter = Router();

// All three roles may read (investigador redacted/anonymized downstream).
const READ = [requireAuth, requireRole(...ROLES)];
// Clinical staff (admin + medico).
const STAFF = [requireAuth, requireRole("admin", "medico")];
// Admin only.
const ADMIN = [requireAuth, requireRole("admin")];

// ── Legacy Orthanc proxy ──────────────────────────────────────────────────────
studiesRouter.get("/api/studies", ...READ, ctrl.listOrthancStudies);
studiesRouter.get("/api/studies/:id", ...READ, ctrl.getOrthancStudy);
studiesRouter.delete("/api/studies/:id", ...ADMIN, ctrl.deleteOrthancStudy);

// ── v1 (Postgres-backed) ──────────────────────────────────────────────────────
studiesRouter.get("/api/v1/studies/:studyId/file", ...READ, ctrl.getStudyFile);
studiesRouter.get(
  "/api/v1/studies/:studyId/instances",
  ...READ,
  ctrl.getStudyInstances,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/instances/:instanceId/file",
  ...READ,
  ctrl.getInstanceFile,
);
studiesRouter.get("/api/v1/studies", ...READ, ctrl.listStudies);
studiesRouter.get(
  "/api/v1/studies/:studyId/zenodo",
  ...READ,
  ctrl.getStudyZenodo,
);
studiesRouter.post(
  "/api/v1/studies/:studyId/zenodo/check",
  ...STAFF,
  ctrl.checkStudyZenodo,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/thumbnail",
  ...READ,
  ctrl.getStudyThumbnail,
);
