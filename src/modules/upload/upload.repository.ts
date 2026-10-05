import { pool } from "../../db/pool";
import type { PhiFinding } from "../../shared/phi-verification";

export interface StudyMetadata {
  orthancStudyId: string;
  orthancInstanceId: string;
  sopInstanceUid: string;
  studyInstanceUid: string;
  patientName: string;
  patientId: string;
  studyDate: string;
  modality: string;
  studyDescription: string;
  seriesDescription: string;
  numberOfImages: number | null;
  instanceNumber: number | null;
  rows: number | null;
  cols: number | null;
  /**
   * When the stored instance was verified to carry no identifying tags, or
   * null when it was not. Written only from a verification of the tags Orthanc
   * read back — never from a caller's assertion (see shared/phi-verification).
   */
  anonymizedAt: Date | null;
  classificationId: number | null;
  /**
   * Set when the PHI check flagged the study in `warn` mode (or found a
   * burned-in warning). `reviewFindings` says why, PHI-free. Optional so
   * callers that don't verify can omit both.
   */
  needsReview?: boolean;
  reviewFindings?: PhiFinding[];
}

/** Look up an existing row by its unique SOP Instance UID. */
export async function findBySopInstanceUid(
  sopInstanceUid: string,
): Promise<{ id: number; orthanc_study_id: string } | undefined> {
  const { rows } = await pool.query(
    "SELECT id, orthanc_study_id FROM studies WHERE sop_instance_uid = $1",
    [sopInstanceUid],
  );
  return rows[0];
}

/** Delete the row for a SOP Instance UID (used by force-replace). */
export async function deleteBySopInstanceUid(
  sopInstanceUid: string,
): Promise<void> {
  await pool.query("DELETE FROM studies WHERE sop_instance_uid = $1", [
    sopInstanceUid,
  ]);
}

/** Insert or update study metadata keyed on the SOP Instance UID. */
export async function upsertStudy(m: StudyMetadata): Promise<any> {
  const { rows } = await pool.query(
    `INSERT INTO studies
       (orthanc_study_id, orthanc_instance_id, sop_instance_uid, study_instance_uid,
        patient_name, patient_id, study_date, modality, study_description,
        series_description, number_of_images,
        instance_number, rows_count, cols_count, anonymized_at, classification_id,
        needs_review, review_findings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (sop_instance_uid) DO UPDATE SET
       orthanc_study_id    = EXCLUDED.orthanc_study_id,
       orthanc_instance_id = EXCLUDED.orthanc_instance_id,
       study_instance_uid  = EXCLUDED.study_instance_uid,
       patient_name        = EXCLUDED.patient_name,
       patient_id          = EXCLUDED.patient_id,
       study_date          = EXCLUDED.study_date,
       modality            = EXCLUDED.modality,
       study_description   = EXCLUDED.study_description,
       series_description  = EXCLUDED.series_description,
       number_of_images    = EXCLUDED.number_of_images,
       instance_number     = EXCLUDED.instance_number,
       rows_count          = EXCLUDED.rows_count,
       cols_count          = EXCLUDED.cols_count,
       anonymized_at       = EXCLUDED.anonymized_at,
       classification_id   = EXCLUDED.classification_id,
       needs_review        = EXCLUDED.needs_review,
       review_findings     = EXCLUDED.review_findings,
       uploaded_at         = NOW()
     RETURNING *`,
    [
      m.orthancStudyId,
      m.orthancInstanceId,
      m.sopInstanceUid,
      m.studyInstanceUid,
      m.patientName,
      m.patientId,
      m.studyDate,
      m.modality,
      m.studyDescription,
      m.seriesDescription,
      m.numberOfImages,
      m.instanceNumber,
      m.rows,
      m.cols,
      m.anonymizedAt,
      m.classificationId,
      m.needsReview ?? false,
      m.reviewFindings ? JSON.stringify(m.reviewFindings) : null,
    ],
  );
  return rows[0];
}
