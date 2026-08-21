import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { uploadSingleFile } from "../../middleware/upload.middleware";
import { uploadStudy } from "./upload.controller";

/**
 * DICOM upload routes (full paths, mounted at root in app.ts). Both the v1 and
 * the legacy `/api/instances` endpoints delegate to the same handler so
 * instances uploaded either way appear in the explorer.
 *
 * Ingest is a write, so it is limited to clinical staff (admin + medico);
 * investigador is read-only.
 */
export const uploadRouter = Router();

const STAFF = [requireAuth, requireRole("admin", "medico")];

uploadRouter.post(
  "/api/v1/studies/upload",
  ...STAFF,
  uploadSingleFile,
  uploadStudy,
);
uploadRouter.post("/api/instances", ...STAFF, uploadSingleFile, uploadStudy);
