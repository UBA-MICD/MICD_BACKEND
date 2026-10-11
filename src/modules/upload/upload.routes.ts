import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { uploadSingleFile } from "../../middleware/upload.middleware";
import { uploadRateLimiter } from "../../middleware/rate-limit.middleware";
import { uploadStudy } from "./upload.controller";

/**
 * DICOM upload routes (full paths, mounted at root in app.ts). Both the v1 and
 * the legacy `/api/instances` endpoints delegate to the same handler so
 * instances uploaded either way appear in the explorer.
 *
 * Ingest is a write, so it is limited to clinical staff (admin + medico) and
 * clinic IT (informatico); investigador is read-only. DICOM is anonymized client-side before upload.
 */
export const uploadRouter = Router();

const UPLOADERS = [requireAuth, requireRole("admin", "medico", "informatico")];

uploadRouter.post(
  "/api/v1/studies/upload",
  ...UPLOADERS,
  uploadRateLimiter,
  uploadSingleFile,
  uploadStudy,
);
uploadRouter.post(
  "/api/instances",
  ...UPLOADERS,
  uploadRateLimiter,
  uploadSingleFile,
  uploadStudy,
);
