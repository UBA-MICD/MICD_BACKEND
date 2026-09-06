import { HttpError, isHttpError } from "../../shared/http-error";
import * as repo from "./validation.repository";
import * as studiesRepo from "./studies.repository";
import { logAction } from "../../shared/audit";
import { AUDIT_ACTIONS } from "../../shared/audit";

export type { ValidationRecord } from "./validation.repository";
export type { ValidationAction } from "./validation.repository";

export interface ValidationResponse {
  validationId: number;
  status: string;
  validatedBy: string;
  validatedAt: string;
}

function toResponse(record: repo.ValidationRecord): ValidationResponse {
  return {
    validationId: record.validationId,
    status: record.action,
    validatedBy: record.validatedBy,
    validatedAt: record.validatedAt.toISOString(),
  };
}

/**
 * Register a new validation (approve / reject / flag for review).
 * Accessible to medico and admin; comment is required when action = 'rejected'.
 */
export async function validateStudy(
  studyId: string,
  action: repo.ValidationAction,
  comment: string | undefined,
  userId: number,
  ip: string,
): Promise<ValidationResponse> {
  if (action === "rejected" && !comment?.trim()) {
    throw new HttpError(400, {
      error: "Un comentario es obligatorio al rechazar un estudio.",
    });
  }

  const exists = await studiesRepo.findFirstInstanceId(studyId);
  if (!exists) {
    throw new HttpError(404, { error: "Estudio no encontrado." });
  }

  // cspell:ignore validación registrada Usar corregirla
  const prior = await repo.findLatestValidation(studyId);
  if (prior) {
    throw new HttpError(409, {
      error:
        "El estudio ya tiene una validación registrada. Usar /validation-correction para corregirla.",
    });
  }

  try {
    const record = await repo.insertValidation({
      studyId,
      action,
      comment: comment?.trim() || undefined,
      userId,
    });

    void logAction({
      userId,
      action: AUDIT_ACTIONS.STUDY_VALIDATED,
      resourceId: studyId,
      ip,
      detail: { action, hasComment: Boolean(comment?.trim()) },
    });

    return toResponse(record);
  } catch (err) {
    if (isHttpError(err)) throw err;
    throw new HttpError(500, { error: (err as Error).message });
  }
}

/**
 * Register a correction over a prior validation (admin only).
 * Fetches the most recent validation for the study and links to it via
 * corrects_id. Throws 404 if no prior validation exists.
 */
export async function correctStudyValidation(
  studyId: string,
  action: repo.ValidationAction,
  comment: string | undefined,
  userId: number,
  ip: string,
): Promise<ValidationResponse> {
  if (action === "rejected" && !comment?.trim()) {
    throw new HttpError(400, {
      error: "Un comentario es obligatorio al rechazar un estudio.",
    });
  }

  const prior = await repo.findLatestValidation(studyId);
  if (!prior) {
    throw new HttpError(404, {
      error: "No existe una validación previa para este estudio.",
    });
  }

  try {
    const record = await repo.insertValidation({
      studyId,
      action,
      comment: comment?.trim() || undefined,
      userId,
      correctsId: prior.validationId,
    });

    void logAction({
      userId,
      action: AUDIT_ACTIONS.STUDY_VALIDATION_CORRECTED,
      resourceId: studyId,
      ip,
      detail: {
        action,
        correctsId: prior.validationId,
        hasComment: Boolean(comment?.trim()),
      },
    });

    return toResponse(record);
  } catch (err) {
    if (isHttpError(err)) throw err;
    throw new HttpError(500, { error: (err as Error).message });
  }
}
