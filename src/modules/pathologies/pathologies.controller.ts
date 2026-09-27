import type { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import * as service from "./pathologies.service";

/**
 * GET /api/v1/pathologies
 * The pathology catalog ({ id, key }[]). Labels are the client's concern — the
 * backend returns only the stable key. Roles: all authenticated.
 */
export const listPathologies: RequestHandler = async (_req, res) => {
  try {
    res.json(await service.listPathologies());
  } catch (err) {
    sendError(res, err);
  }
};
