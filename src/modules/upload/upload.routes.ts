import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { uploadSingleFile } from "../../middleware/upload.middleware";
import { uploadStudy } from "./upload.controller";

/**
 * DICOM upload routes (full paths, mounted at root in app.ts). Both the v1 and
 * the legacy `/api/instances` endpoints delegate to the same handler so
 * instances uploaded either way appear in the explorer.
 */
export const uploadRouter = Router();

uploadRouter.post(
  "/api/v1/studies/upload",
  requireAuth,
  uploadSingleFile,
  uploadStudy,
);
uploadRouter.post(
  "/api/instances",
  requireAuth,
  uploadSingleFile,
  uploadStudy,
);
