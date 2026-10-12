import type { RequestHandler } from "express";
import { sendError, HttpError } from "../../shared/http-error";
import * as service from "./segmentation.service";

/**
 * POST /api/v1/ml/segmentation
 * Body: { sopInstanceUid, seed?, points?, smoothingPasses? }
 *
 * Segment one image stored on the server: the DICOM is fetched from Orthanc by
 * its SOP Instance UID and run through the inference service (TK-44). The
 * candidate is persisted under the requesting user so it can be corrected
 * later (US-45). Images opened off the local disk get a 422.
 */
export const segmentImage: RequestHandler = async (req, res) => {
  try {
    const body = (req.body ?? {}) as service.SegmentationRequest;
    const result = await service.runSegmentation(body, {
      userId: Number(req.user!.sub),
      ip: req.ip ?? "",
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/** Reads and validates the `:id` path param as a positive integer. */
function segmentationId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, { error: "El id de segmentación es inválido." });
  }
  return id;
}

/**
 * POST /api/v1/ml/segmentation/:id/corrections
 * Body: { correctedRle: number[], maskShape: [h, w], editSummary?: object }
 * Roles: medico, admin
 */
export const saveCorrection: RequestHandler = async (req, res) => {
  try {
    const { correctedRle, maskShape, editSummary } = (req.body ?? {}) as {
      correctedRle: number[];
      maskShape: [number, number];
      editSummary?: Record<string, unknown>;
    };
    const result = await service.saveCorrection({
      segmentationId: segmentationId(req.params.id),
      correctedRle,
      maskShape,
      editSummary: editSummary ?? null,
      userId: Number(req.user!.sub),
      ip: req.ip ?? "",
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * POST /api/v1/ml/segmentation/:id/accept
 * Roles: medico, admin
 */
export const acceptSegmentation: RequestHandler = async (req, res) => {
  try {
    const result = await service.acceptSegmentation({
      segmentationId: segmentationId(req.params.id),
      userId: Number(req.user!.sub),
      ip: req.ip ?? "",
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * POST /api/v1/ml/segmentation/:id/discard
 * Roles: medico, admin
 */
export const discardSegmentation: RequestHandler = async (req, res) => {
  try {
    const result = await service.discardSegmentation({
      segmentationId: segmentationId(req.params.id),
      userId: Number(req.user!.sub),
      ip: req.ip ?? "",
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * GET /api/v1/ml/segmentation/:id/corrections
 * Returns the candidate plus its full correction chain.
 * Roles: all authenticated
 */
export const getSegmentationHistory: RequestHandler = async (req, res) => {
  try {
    const result = await service.getHistory(segmentationId(req.params.id));
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * GET /api/v1/ml/segmentation?studyId=..&instanceId=..
 * The current segmentation (original + latest correction masks) for one image,
 * or null. Lets the viewer redraw the polygon after a slice/layout change or a
 * page reload (bug 3). Roles: all authenticated.
 */
export const getSegmentationForInstance: RequestHandler = async (req, res) => {
  try {
    const studyId = String(req.query.studyId ?? "").trim();
    const instanceId = String(req.query.instanceId ?? "").trim();
    if (!studyId || !instanceId) {
      res.status(400).json({
        error: "Se requieren 'studyId' e 'instanceId'.",
      });
      return;
    }
    const result = await service.getLatestForInstance(studyId, instanceId);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};
