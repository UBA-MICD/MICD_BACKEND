import { HttpError } from "../../shared/http-error";
import { orthancClient } from "../../clients/orthanc.client";
import { logAction, AUDIT_ACTIONS } from "../../shared/audit";
import * as repo from "./ml.repository";

export type { MLPredictionRecord } from "./ml.repository";

export interface MLPredictionResponse {
  predictionId: number;
  studyId: string;
  label: string;
  confidence: number;
  analyzedBy: string;
  analyzedAt: string;
}

function toResponse(record: repo.MLPredictionRecord): MLPredictionResponse {
  return {
    predictionId: record.predictionId,
    studyId: record.studyId,
    label: record.label,
    confidence: record.confidence,
    analyzedBy: record.analyzedBy,
    analyzedAt: record.analyzedAt.toISOString(),
  };
}

/**
 * Run (stub) ML inference on a study and persist the result.
 * Verifies study existence via Orthanc directly — not via the Postgres
 * `studies` table — so studies uploaded outside the backend are handled.
 * Admin-only.
 */
export async function analyzeStudy(
  studyId: string,
  userId: number,
  ip: string,
): Promise<MLPredictionResponse> {
  try {
    await orthancClient.getStudyInstances(studyId);
  } catch {
    throw new HttpError(404, { error: "Estudio no encontrado en Orthanc." });
  }

  // TODO: replace stub with real model call, e.g.:
  //   const result = await mlInferenceService.predict(studyId);
  const label = "normal";
  const confidence = 0.87;

  const record = await repo.insertPrediction({
    studyId,
    label,
    confidence,
    userId,
  });

  void logAction({
    userId,
    action: AUDIT_ACTIONS.STUDY_ML_ANALYSIS_STARTED,
    resourceId: studyId,
    ip,
    detail: { label, confidence },
  });

  return toResponse(record);
}

/** Return the most-recent prediction for a study, or null. */
export async function getLatestPrediction(
  studyId: string,
): Promise<MLPredictionResponse | null> {
  const record = await repo.findLatestPrediction(studyId);
  return record ? toResponse(record) : null;
}
