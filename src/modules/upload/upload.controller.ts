import { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import { logAction, AUDIT_ACTIONS } from "../../shared/audit";
import { uploadDicom } from "./upload.service";
import { parseClassificationId } from "./classification";

/**
 * POST handler for single-file DICOM ingest (shared by the v1 and legacy upload
 * routes). Anonymization happens client-side before the bytes are sent (the web
 * JS scrubber or the desktop app's Python anonymizer), so this handler stores
 * what it receives and returns 201 with the stored study.
 */
export const uploadStudy: RequestHandler = async (req, res) => {
  console.log(
    `[upload] received — file=${req.file?.originalname ?? "none"} size=${req.file?.size ?? 0} mimetype=${req.file?.mimetype ?? "none"}`,
  );
  if (!req.file) {
    console.log(
      `[upload] no file in request — body keys: ${Object.keys(req.body ?? {}).join(", ")}`,
    );
    res.status(400).json({ error: "No DICOM file provided (field: file)" });
    return;
  }

  try {
    const classificationId = parseClassificationId(req.body?.classification_id);
    const result = await uploadDicom(
      { buffer: req.file.buffer, size: req.file.size },
      req.query.force === "true",
      classificationId,
    );
    // Resource id is only known once Orthanc/Postgres assign it, so the
    // audit write happens here rather than via param-based middleware (TK-06).
    void logAction({
      userId: req.user?.sub ?? null,
      action: AUDIT_ACTIONS.STUDY_UPLOADED,
      resourceId: String(result.study.orthanc_study_id),
      ip: req.ip ?? "",
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};
