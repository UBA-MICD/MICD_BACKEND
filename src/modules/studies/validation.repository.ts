import { pool } from "../../db/pool";

export type ValidationAction = "approved" | "rejected" | "review";

export interface ValidationRecord {
  validationId: number;
  studyId: string;
  action: ValidationAction;
  comment: string | null;
  userId: number;
  validatedBy: string;
  validatedAt: Date;
  correctsId: number | null;
}

/**
 * Most-recent validation for a study (the canonical current status).
 * Returns null when the study has never been validated.
 */
export async function findLatestValidation(
  studyId: string,
): Promise<ValidationRecord | null> {
  const { rows } = await pool.query<{
    id: number;
    study_id: string;
    action: ValidationAction;
    comment: string | null;
    user_id: number;
    email: string;
    created_at: Date;
    corrects_id: number | null;
  }>(
    `SELECT sv.id, sv.study_id, sv.action, sv.comment, sv.user_id,
            u.email, sv.created_at, sv.corrects_id
     FROM study_validations sv
     JOIN users u ON u.id = sv.user_id
     WHERE sv.study_id = $1
     ORDER BY sv.created_at DESC
     LIMIT 1`,
    [studyId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    validationId: r.id,
    studyId: r.study_id,
    action: r.action,
    comment: r.comment,
    userId: r.user_id,
    validatedBy: r.email,
    validatedAt: r.created_at,
    correctsId: r.corrects_id,
  };
}

/** Insert a new validation row and return the full record (with user email). */
export async function insertValidation(params: {
  studyId: string;
  action: ValidationAction;
  comment?: string;
  userId: number;
  correctsId?: number;
}): Promise<ValidationRecord> {
  const { rows } = await pool.query<{
    id: number;
    study_id: string;
    action: ValidationAction;
    comment: string | null;
    user_id: number;
    email: string;
    created_at: Date;
    corrects_id: number | null;
  }>(
    `INSERT INTO study_validations (study_id, action, comment, user_id, corrects_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING
       id,
       study_id,
       action,
       comment,
       user_id,
       (SELECT email FROM users WHERE id = $4) AS email,
       created_at,
       corrects_id`,
    [
      params.studyId,
      params.action,
      params.comment ?? null,
      params.userId,
      params.correctsId ?? null,
    ],
  );
  const r = rows[0];
  return {
    validationId: r.id,
    studyId: r.study_id,
    action: r.action,
    comment: r.comment,
    userId: r.user_id,
    validatedBy: r.email,
    validatedAt: r.created_at,
    correctsId: r.corrects_id,
  };
}
