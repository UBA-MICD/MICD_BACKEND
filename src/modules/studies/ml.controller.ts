import type { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import * as service from "./ml.service";

/**
 * POST /api/v1/studies/:studyId/ml/analyze
 * Trigger ML analysis for a study and persist the result.
 * Admin only.
 */
export const analyzeStudy: RequestHandler = async (req, res) => {
  try {
    const result = await service.analyzeStudy(
      req.params.studyId,
      Number(req.user!.sub),
      req.ip ?? "",
    );
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * GET /api/v1/studies/:studyId/ml/prediction
 * Return the most recent ML prediction for a study, or null.
 * All authenticated roles.
 */
export const getStudyPrediction: RequestHandler = async (req, res) => {
  try {
    const result = await service.getLatestPrediction(req.params.studyId);
    res.json(result ?? null);
  } catch (err) {
    sendError(res, err);
  }
};
