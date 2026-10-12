import { pool } from "../../db/pool";

/**
 * Persistence for AI segmentation candidates and their human corrections
 * (US-45). The candidate mask lives in `ml_segmentations` and is never
 * overwritten; every correction is a new append-only row in
 * `ml_segmentation_corrections`, chained through `corrects_id`. This mirrors the
 * `study_validations` audit chain (see validation.repository.ts).
 */

/** Run-length encoding: alternating run lengths, row-major, starting with 0s. */
export type Rle = number[];

/** [height, width] of the mask space. */
export type MaskShape = [number, number];

export type SegmentationStatus =
  "candidate" | "accepted" | "corrected" | "discarded" | "failed";

export interface SegmentationRecord {
  id: number;
  studyId: string | null;
  instanceId: string;
  seriesId: string | null;
  modelId: string | null;
  modelVersion: string | null;
  prompt: Record<string, unknown>;
  maskRle: Rle | null;
  maskShape: MaskShape | null;
  status: SegmentationStatus;
  errorCode: string | null;
  createdBy: number;
  createdByEmail: string;
  createdAt: Date;
  reviewedBy: number | null;
  reviewedByEmail: string | null;
  reviewedAt: Date | null;
}

export interface CorrectionRecord {
  id: number;
  segmentationId: number;
  studyId: string | null;
  instanceId: string;
  correctedRle: Rle;
  maskShape: MaskShape;
  editSummary: Record<string, unknown> | null;
  correctsId: number | null;
  createdBy: number;
  createdByEmail: string;
  createdAt: Date;
}

interface SegmentationRow {
  id: number;
  study_id: string | null;
  instance_id: string;
  series_id: string | null;
  model_id: string | null;
  model_version: string | null;
  prompt: Record<string, unknown>;
  mask_rle: Rle | null;
  mask_shape: MaskShape | null;
  status: SegmentationStatus;
  error_code: string | null;
  created_by: number;
  created_by_email: string;
  created_at: Date;
  reviewed_by: number | null;
  reviewed_by_email: string | null;
  reviewed_at: Date | null;
}

interface CorrectionRow {
  id: number;
  segmentation_id: number;
  study_id: string | null;
  instance_id: string;
  corrected_rle: Rle;
  mask_shape: MaskShape;
  edit_summary: Record<string, unknown> | null;
  corrects_id: number | null;
  created_by: number;
  created_by_email: string;
  created_at: Date;
}

function toSegmentation(r: SegmentationRow): SegmentationRecord {
  return {
    id: r.id,
    studyId: r.study_id,
    instanceId: r.instance_id,
    seriesId: r.series_id,
    modelId: r.model_id,
    modelVersion: r.model_version,
    prompt: r.prompt ?? {},
    maskRle: r.mask_rle,
    maskShape: r.mask_shape,
    status: r.status,
    errorCode: r.error_code,
    createdBy: r.created_by,
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
    reviewedBy: r.reviewed_by,
    reviewedByEmail: r.reviewed_by_email,
    reviewedAt: r.reviewed_at,
  };
}

function toCorrection(r: CorrectionRow): CorrectionRecord {
  return {
    id: r.id,
    segmentationId: r.segmentation_id,
    studyId: r.study_id,
    instanceId: r.instance_id,
    correctedRle: r.corrected_rle,
    maskShape: r.mask_shape,
    editSummary: r.edit_summary,
    correctsId: r.corrects_id,
    createdBy: r.created_by,
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
  };
}

// SELECT list shared by every segmentation read: joins the author (and optional
// reviewer) so the API can show "quién" without a second round-trip.
const SEG_SELECT = `
  SELECT s.id, s.study_id, s.instance_id, s.series_id, s.model_id, s.model_version,
         s.prompt, s.mask_rle, s.mask_shape, s.status, s.error_code,
         s.created_by, cu.email AS created_by_email, s.created_at,
         s.reviewed_by, ru.email AS reviewed_by_email, s.reviewed_at
  FROM ml_segmentations s
  JOIN users cu ON cu.id = s.created_by
  LEFT JOIN users ru ON ru.id = s.reviewed_by
`;

export interface StoredInstance {
  orthancInstanceId: string;
  studyInstanceUid: string | null;
}

/**
 * A stored instance by its DICOM SOP Instance UID: its Orthanc id (to fetch
 * the file) and its study UID (so a candidate is filed under the study the
 * server knows, never one the client claims).
 */
export async function findStoredInstance(
  sopInstanceUid: string,
): Promise<StoredInstance | null> {
  const { rows } = await pool.query<{
    orthanc_instance_id: string;
    study_instance_uid: string | null;
  }>(
    `SELECT orthanc_instance_id, study_instance_uid
       FROM studies WHERE sop_instance_uid = $1 LIMIT 1`,
    [sopInstanceUid],
  );
  const row = rows[0];
  return row
    ? {
        orthancInstanceId: row.orthanc_instance_id,
        studyInstanceUid: row.study_instance_uid,
      }
    : null;
}

export async function insertSegmentation(params: {
  studyId?: string | null;
  instanceId: string;
  seriesId?: string | null;
  modelId?: string | null;
  modelVersion?: string | null;
  prompt?: Record<string, unknown>;
  maskRle: Rle | null;
  maskShape: MaskShape | null;
  status: SegmentationStatus;
  errorCode?: string | null;
  createdBy: number;
}): Promise<SegmentationRecord> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ml_segmentations
       (study_id, instance_id, series_id, model_id, model_version, prompt,
        mask_rle, mask_shape, status, error_code, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
     RETURNING id`,
    [
      params.studyId ?? null,
      params.instanceId,
      params.seriesId ?? null,
      params.modelId ?? null,
      params.modelVersion ?? null,
      JSON.stringify(params.prompt ?? {}),
      params.maskRle === null ? null : JSON.stringify(params.maskRle),
      params.maskShape === null ? null : JSON.stringify(params.maskShape),
      params.status,
      params.errorCode ?? null,
      params.createdBy,
    ],
  );
  const record = await findSegmentationById(rows[0].id);
  // The row was just inserted in this connection; it must exist.
  return record as SegmentationRecord;
}

export async function findSegmentationById(
  id: number,
): Promise<SegmentationRecord | null> {
  const { rows } = await pool.query<SegmentationRow>(
    `${SEG_SELECT} WHERE s.id = $1`,
    [id],
  );
  return rows[0] ? toSegmentation(rows[0]) : null;
}

/** Most-recent candidate for an image (the canonical current segmentation). */
export async function findLatestSegmentation(
  studyId: string,
  instanceId: string,
): Promise<SegmentationRecord | null> {
  const { rows } = await pool.query<SegmentationRow>(
    `${SEG_SELECT}
     WHERE s.study_id = $1 AND s.instance_id = $2
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [studyId, instanceId],
  );
  return rows[0] ? toSegmentation(rows[0]) : null;
}

/** Stamp status (and, for a human review, who reviewed it and when). */
export async function updateSegmentationStatus(
  id: number,
  status: SegmentationStatus,
  reviewedBy?: number,
): Promise<SegmentationRecord | null> {
  await pool.query(
    `UPDATE ml_segmentations
     SET status = $2,
         reviewed_by = COALESCE($3, reviewed_by),
         reviewed_at = CASE WHEN $3 IS NULL THEN reviewed_at ELSE NOW() END
     WHERE id = $1`,
    [id, status, reviewedBy ?? null],
  );
  return findSegmentationById(id);
}

export async function insertCorrection(params: {
  segmentationId: number;
  studyId?: string | null;
  instanceId: string;
  correctedRle: Rle;
  maskShape: MaskShape;
  editSummary?: Record<string, unknown> | null;
  correctsId?: number | null;
  createdBy: number;
}): Promise<CorrectionRecord> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ml_segmentation_corrections
       (segmentation_id, study_id, instance_id, corrected_rle, mask_shape,
        edit_summary, corrects_id, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      params.segmentationId,
      params.studyId ?? null,
      params.instanceId,
      JSON.stringify(params.correctedRle),
      JSON.stringify(params.maskShape),
      params.editSummary == null ? null : JSON.stringify(params.editSummary),
      params.correctsId ?? null,
      params.createdBy,
    ],
  );
  const list = await listCorrections(params.segmentationId);
  // The row we just inserted is the newest; return it.
  return list.find((c) => c.id === rows[0].id) as CorrectionRecord;
}

/** Full correction chain for a segmentation, newest first. */
export async function listCorrections(
  segmentationId: number,
): Promise<CorrectionRecord[]> {
  const { rows } = await pool.query<CorrectionRow>(
    `SELECT c.id, c.segmentation_id, c.study_id, c.instance_id, c.corrected_rle,
            c.mask_shape, c.edit_summary, c.corrects_id, c.created_by,
            u.email AS created_by_email, c.created_at
     FROM ml_segmentation_corrections c
     JOIN users u ON u.id = c.created_by
     WHERE c.segmentation_id = $1
     ORDER BY c.created_at DESC`,
    [segmentationId],
  );
  return rows.map(toCorrection);
}
