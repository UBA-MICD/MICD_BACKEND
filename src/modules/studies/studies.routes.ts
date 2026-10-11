import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { auditStudyAccess } from "../../middleware/audit-access.middleware";
import { AUDIT_ACTIONS } from "../../shared/audit";
import * as ctrl from "./studies.controller";
import * as validationCtrl from "./validation.controller";
import * as mlCtrl from "./ml.controller";

/**
 * Study read routes. Registered with their full paths (mounted at root in
 * app.ts) so the two API generations keep their exact URLs:
 *   - legacy `/api/studies*`  — thin Orthanc proxy
 *   - current `/api/v1/studies*` — Postgres-backed, paginated/filtered
 *
 * Every route requires a valid token (requireAuth) plus a permitted role
 * (requireRole). Reads are open to admin, medico and investigador — investigador sees the same
 * studies with PHI redacted (metadata) or anonymized (files); deletes are
 * admin-only; the outward-facing Zenodo publish-check excludes investigador.
 * informatico (clinic IT) only gets the list and file-download routes it needs
 * to find and fetch a study (DOWNLOAD).
 *
 * View/download/delete routes also carry `auditStudyAccess` (TK-06): every
 * successful access is appended to `audit_log` with user, action, study id,
 * timestamp and IP, for the medical-data access trail.
 */
export const studiesRouter = Router();

// Viewing roles (investigador redacted/anonymized downstream).
const READ = [requireAuth, requireRole("admin", "medico", "investigador")];
// Viewing roles plus informatico: listing studies and downloading their files.
const DOWNLOAD = [
  requireAuth,
  requireRole("admin", "medico", "investigador", "informatico"),
];
// Clinical staff (admin + medico).
const STAFF = [requireAuth, requireRole("admin", "medico")];
// Admin only.
const ADMIN = [requireAuth, requireRole("admin")];

// ── Legacy Orthanc proxy ──────────────────────────────────────────────────────
studiesRouter.get(
  "/api/studies",
  ...READ,
  auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED, "id"),
  ctrl.listOrthancStudies,
);
studiesRouter.get(
  "/api/studies/:id",
  ...READ,
  auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED, "id"),
  ctrl.getOrthancStudy,
);
studiesRouter.delete(
  "/api/studies/:id",
  ...ADMIN,
  auditStudyAccess(AUDIT_ACTIONS.STUDY_DELETED, "id"),
  ctrl.deleteOrthancStudy,
);

// ── v1 (Postgres-backed) ──────────────────────────────────────────────────────
studiesRouter.get(
  "/api/v1/studies/:studyId/file",
  ...DOWNLOAD,
  auditStudyAccess(AUDIT_ACTIONS.STUDY_DOWNLOADED),
  ctrl.getStudyFile,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/instances",
  ...DOWNLOAD,
  auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED),
  ctrl.getStudyInstances,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/instances/:instanceId/file",
  ...DOWNLOAD,
  auditStudyAccess(AUDIT_ACTIONS.STUDY_DOWNLOADED),
  ctrl.getInstanceFile,
);
studiesRouter.get(
  "/api/v1/studies",
  ...DOWNLOAD,
  auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED),
  ctrl.listStudies,
);
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
  auditStudyAccess(AUDIT_ACTIONS.STUDY_VIEWED),
  ctrl.getStudyThumbnail,
);

// ── Diagnostic validation (US-26) ─────────────────────────────────────────────
studiesRouter.get(
  "/api/v1/studies/:studyId/validation",
  ...READ,
  validationCtrl.getStudyValidation,
);
studiesRouter.post(
  "/api/v1/studies/:studyId/validate",
  ...STAFF,
  validationCtrl.validateStudy,
);
studiesRouter.post(
  "/api/v1/studies/:studyId/validation-correction",
  ...ADMIN,
  validationCtrl.correctStudyValidation,
);

// ── ML prediction (US-ML) ─────────────────────────────────────────────────────
studiesRouter.post(
  "/api/v1/studies/:studyId/ml/analyze",
  ...ADMIN,
  mlCtrl.analyzeStudy,
);
studiesRouter.get(
  "/api/v1/studies/:studyId/ml/prediction",
  ...READ,
  mlCtrl.getStudyPrediction,
);
