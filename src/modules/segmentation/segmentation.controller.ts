import type { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import * as service from "./segmentation.service";

/**
 * POST /api/v1/ml/segmentation
 *
 * Segment one image. Image-scoped rather than study-scoped on purpose: the
 * viewer also opens DICOM files straight off the local disk, which have no
 * Orthanc study id, and the segmentation only ever needs Rows/Columns plus the
 * source UIDs it echoes back as the derived image's reference.
 */
export const segmentImage: RequestHandler = async (req, res) => {
  try {
    const body = (req.body ?? {}) as service.SegmentationRequest;
    const result = await service.runSegmentation(body);
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};
