import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import {
  uploadSingleFile,
  uploadMultipleFiles,
} from "../../middleware/upload.middleware";
import { uploadRateLimiter } from "../../middleware/rate-limit.middleware";
import {
  uploadStudy,
  uploadStudyBatch,
  getAnonymizationStatus,
} from "./upload.controller";

/**
 * DICOM upload routes (full paths, mounted at root in app.ts). Both the v1 and
 * the legacy `/api/instances` endpoints delegate to the same handler so
 * instances uploaded either way appear in the explorer.
 *
 * Ingest is a write, so it is limited to clinical staff (admin + medico);
 * investigador is read-only. Every ingest path anonymizes before storage
 * (US-16); the batch path does it in the background and exposes a status the
 * client polls.
 */
export const uploadRouter = Router();

const STAFF = [requireAuth, requireRole("admin", "medico")];

uploadRouter.post(
  "/api/v1/studies/upload",
  ...STAFF,
  uploadRateLimiter,
  uploadSingleFile,
  uploadStudy,
);
uploadRouter.post(
  "/api/instances",
  ...STAFF,
  uploadRateLimiter,
  uploadSingleFile,
  uploadStudy,
);

// Multi-file (study) ingest — anonymized in the background, returns 202 + jobId.
uploadRouter.post(
  "/api/v1/studies/upload-batch",
  ...STAFF,
  uploadRateLimiter,
  uploadMultipleFiles,
  uploadStudyBatch,
);

// Anonymization job status for the explorer / upload UI to poll.
uploadRouter.get(
  "/api/v1/anonymization/:jobId",
  ...STAFF,
  getAnonymizationStatus,
);
