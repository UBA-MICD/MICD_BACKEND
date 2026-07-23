import { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import { uploadDicom } from "./upload.service";

/** POST handler for DICOM ingest (shared by the v1 and legacy upload routes). */
export const uploadStudy: RequestHandler = async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No DICOM file provided (field: file)" });
    return;
  }

  try {
    const result = await uploadDicom(
      { buffer: req.file.buffer, size: req.file.size },
      req.query.force === "true",
    );
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};
