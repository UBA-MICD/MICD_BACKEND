import type { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import * as service from "./validation.service";

/**
 * POST /api/v1/studies/:studyId/validate
 * Body: { action: "approved" | "rejected" | "review", comment?: string }
 * Roles: medico, admin
 */
export const validateStudy: RequestHandler = async (req, res) => {
  try {
    const { studyId } = req.params;
    const { action, comment } = req.body as {
      action: service.ValidationAction;
      comment?: string;
    };

    if (!action || !["approved", "rejected", "review"].includes(action)) {
      res.status(400).json({
        error: "El campo 'action' debe ser 'approved', 'rejected' o 'review'.",
      });
      return;
    }

    const result = await service.validateStudy(
      studyId,
      action,
      comment,
      Number(req.user!.sub),
      req.ip ?? "",
    );

    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * POST /api/v1/studies/:studyId/validation-correction
 * Body: { action: "approved" | "rejected" | "review", comment?: string }
 * Roles: admin only
 */
export const correctStudyValidation: RequestHandler = async (req, res) => {
  try {
    const { studyId } = req.params;
    const { action, comment } = req.body as {
      action: service.ValidationAction;
      comment?: string;
    };

    if (!action || !["approved", "rejected", "review"].includes(action)) {
      res.status(400).json({
        error: "El campo 'action' debe ser 'approved', 'rejected' o 'review'.",
      });
      return;
    }

    const result = await service.correctStudyValidation(
      studyId,
      action,
      comment,
      Number(req.user!.sub),
      req.ip ?? "",
    );

    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
};
