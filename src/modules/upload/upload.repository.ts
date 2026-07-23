import { pool } from "../../db/pool";

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
  instanceNumber: number | null;
  rows: number | null;
  cols: number | null;
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
        instance_number, rows_count, cols_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (sop_instance_uid) DO UPDATE SET
       orthanc_study_id    = EXCLUDED.orthanc_study_id,
       orthanc_instance_id = EXCLUDED.orthanc_instance_id,
       study_instance_uid  = EXCLUDED.study_instance_uid,
       patient_name        = EXCLUDED.patient_name,
       patient_id          = EXCLUDED.patient_id,
       study_date          = EXCLUDED.study_date,
       modality            = EXCLUDED.modality,
       study_description   = EXCLUDED.study_description,
       instance_number     = EXCLUDED.instance_number,
       rows_count          = EXCLUDED.rows_count,
       cols_count          = EXCLUDED.cols_count,
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
      m.instanceNumber,
      m.rows,
      m.cols,
    ],
  );
  return rows[0];
}
