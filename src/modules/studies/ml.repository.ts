import { pool } from "../../db/pool";

export interface MLPredictionRecord {
  predictionId: number;
  studyId: string;
  label: string;
  confidence: number;
  analyzedBy: string;
  analyzedAt: Date;
}

/** Most-recent ML prediction for a study, or null if none exists. */
export async function findLatestPrediction(
  studyId: string,
): Promise<MLPredictionRecord | null> {
  const { rows } = await pool.query<{
    id: number;
    study_id: string;
    label: string;
    confidence: number;
    email: string;
    analyzed_at: Date;
  }>(
    `SELECT p.id, p.study_id, p.label, p.confidence, u.email, p.analyzed_at
     FROM study_ml_predictions p
     JOIN users u ON u.id = p.analyzed_by
     WHERE p.study_id = $1
     ORDER BY p.analyzed_at DESC
     LIMIT 1`,
    [studyId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    predictionId: r.id,
    studyId: r.study_id,
    label: r.label,
    confidence: r.confidence,
    analyzedBy: r.email,
    analyzedAt: r.analyzed_at,
  };
}

/** Insert a new prediction row and return the full record with user email. */
export async function insertPrediction(params: {
  studyId: string;
  label: string;
  confidence: number;
  userId: number;
}): Promise<MLPredictionRecord> {
  const { rows } = await pool.query<{
    id: number;
    study_id: string;
    label: string;
    confidence: number;
    email: string;
    analyzed_at: Date;
  }>(
    `INSERT INTO study_ml_predictions (study_id, label, confidence, analyzed_by)
     VALUES ($1, $2, $3, $4)
     RETURNING
       id,
       study_id,
       label,
       confidence,
       (SELECT email FROM users WHERE id = $4) AS email,
       analyzed_at`,
    [params.studyId, params.label, params.confidence, params.userId],
  );
  const r = rows[0];
  return {
    predictionId: r.id,
    studyId: r.study_id,
    label: r.label,
    confidence: r.confidence,
    analyzedBy: r.email,
    analyzedAt: r.analyzed_at,
  };
}
