import { pool } from "../../db/pool";
import { InstanceRow } from "../../shared/instances-util";

export type ValidationStatusFilter =
  "approved" | "rejected" | "review" | "none" | null;

export interface StudyFilters {
  modality: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  search: string | null;
  zenodoLinked: boolean | null;
  description: string | null;
  validationStatus: ValidationStatusFilter;
}

// Shared WHERE clause for the paginated listing — parameterized so both the
// COUNT and the page query use identical filter semantics.
// $1 modality, $2 dateFrom, $3 dateTo, $4 patient search, $5 zenodoLinked,
// $6 description, $7 validationStatus ("none" = never validated, null = no filter)
const FILTER_WHERE = `
  ($1::text IS NULL OR modality = $1)
  AND ($2::text IS NULL OR study_date >= $2)
  AND ($3::text IS NULL OR study_date <= $3)
  AND (
    $4::text IS NULL
    OR patient_name ILIKE '%' || $4 || '%'
    OR patient_id   ILIKE '%' || $4 || '%'
  )
  AND ($5::bool IS NULL OR ($5 = true AND (zenodo_doi IS NOT NULL OR zenodo_source_doi IS NOT NULL)))
  AND ($6::text IS NULL OR study_description ILIKE '%' || $6 || '%')
  AND (
    $7::text IS NULL
    OR ($7 = 'none' AND NOT EXISTS (
      SELECT 1 FROM study_validations WHERE study_id = orthanc_study_id
    ))
    OR ($7 != 'none' AND (
      SELECT action FROM study_validations
      WHERE study_id = orthanc_study_id
      ORDER BY created_at DESC LIMIT 1
    ) = $7)
  )`;

function filterArgs(f: StudyFilters): (string | boolean | null)[] {
  return [
    f.modality,
    f.dateFrom,
    f.dateTo,
    f.search,
    f.zenodoLinked,
    f.description,
    f.validationStatus,
  ];
}

/** The first stored instance id for a study, in insertion order, or null. */
export async function findFirstInstanceId(
  studyId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT orthanc_instance_id FROM studies WHERE orthanc_study_id = $1 ORDER BY id ASC LIMIT 1",
    [studyId],
  );
  return rows[0]?.orthanc_instance_id ?? null;
}

/** All instance rows for a study (unordered — caller orders them). */
export async function findInstances(studyId: string): Promise<InstanceRow[]> {
  const { rows } = await pool.query<InstanceRow>(
    "SELECT id, orthanc_instance_id, instance_number FROM studies WHERE orthanc_study_id = $1",
    [studyId],
  );
  return rows;
}

/** Whether a given (study, instance) pair exists in the metadata table. */
export async function instanceExists(
  studyId: string,
  instanceId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM studies WHERE orthanc_study_id = $1 AND orthanc_instance_id = $2 LIMIT 1",
    [studyId, instanceId],
  );
  return rows.length > 0;
}

/** Count of distinct studies matching the filters. */
export async function countStudies(filters: StudyFilters): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `
    SELECT COUNT(*) AS total
    FROM (
      SELECT s.orthanc_study_id FROM studies s
      WHERE ${FILTER_WHERE}
      GROUP BY s.orthanc_study_id
    ) sub
  `,
    filterArgs(filters),
  );
  return parseInt(rows[0].total, 10);
}

export interface StudyZenodoMeta {
  zenodo_doi: string | null;
  zenodo_published_at: Date | null;
  zenodo_source_doi: string | null;
  zenodo_source_record_id: number | null;
  zenodo_imported_at: Date | null;
  zenodo_version: string | null;
  zenodo_concept_record_id: number | null;
  zenodo_new_version_available: boolean | null;
  patient_name: string | null;
  study_date: string | null;
  modality: string | null;
}

export async function setNewVersionAvailable(
  recordId: number,
  value: boolean,
): Promise<void> {
  await pool.query(
    "UPDATE studies SET zenodo_new_version_available = $1 WHERE zenodo_source_record_id = $2",
    [value, recordId],
  );
}

/** Zenodo-related columns for a single study, or null if not found. */
export async function findStudyZenodoMeta(
  studyId: string,
): Promise<StudyZenodoMeta | null> {
  const { rows } = await pool.query<StudyZenodoMeta>(
    `SELECT
       MAX(zenodo_doi)                    AS zenodo_doi,
       MAX(zenodo_published_at)           AS zenodo_published_at,
       MAX(zenodo_source_doi)             AS zenodo_source_doi,
       MAX(zenodo_source_record_id)       AS zenodo_source_record_id,
       MAX(zenodo_imported_at)            AS zenodo_imported_at,
       MAX(zenodo_version)                AS zenodo_version,
       MAX(zenodo_concept_record_id)      AS zenodo_concept_record_id,
       BOOL_OR(zenodo_new_version_available) AS zenodo_new_version_available,
       MAX(patient_name)                  AS patient_name,
       MAX(study_date)                    AS study_date,
       MAX(modality)                      AS modality
     FROM studies
     WHERE orthanc_study_id = $1`,
    [studyId],
  );
  // GROUP BY is absent — aggregate over all instances of the study. If the
  // study doesn't exist at all, the aggregate returns one row with all NULLs.
  const row = rows[0];
  if (
    !row ||
    (row.zenodo_doi === null &&
      row.zenodo_source_doi === null &&
      row.patient_name === null)
  ) {
    return null;
  }
  return row;
}

/** One page of studies, each collapsed to a single row per orthanc_study_id. */
export async function findStudies(
  filters: StudyFilters,
  limit: number,
  offset: number,
): Promise<Record<string, any>[]> {
  const { rows } = await pool.query<Record<string, any>>(
    `
    SELECT
      MIN(s.id)                    AS id,
      s.orthanc_study_id,
      MIN(s.orthanc_instance_id)   AS orthanc_instance_id,
      MAX(s.patient_name)          AS patient_name,
      MAX(s.patient_id)            AS patient_id,
      MAX(s.study_date)            AS study_date,
      MAX(s.modality)              AS modality,
      MAX(s.study_description)     AS study_description,
      MAX(s.uploaded_at)           AS uploaded_at,
      COUNT(*)                     AS num_instances,
      MAX(s.zenodo_doi)            AS zenodo_doi,
      MAX(s.zenodo_published_at)   AS zenodo_published_at,
      MAX(s.zenodo_source_record_id) AS zenodo_source_record_id,
      MAX(s.zenodo_source_doi)     AS zenodo_source_doi,
      MAX(s.zenodo_imported_at)    AS zenodo_imported_at,
      BOOL_OR(s.zenodo_new_version_available) AS zenodo_new_version_available,
      v.action                     AS validation_status,
      u.email                      AS validated_by,
      v.created_at                 AS validated_at
    FROM studies s
    LEFT JOIN LATERAL (
      SELECT action, user_id, created_at
      FROM study_validations
      WHERE study_id = s.orthanc_study_id
      ORDER BY created_at DESC
      LIMIT 1
    ) v ON true
    LEFT JOIN users u ON u.id = v.user_id
    WHERE ${FILTER_WHERE}
    GROUP BY s.orthanc_study_id, v.action, u.email, v.created_at
    ORDER BY MAX(s.uploaded_at) DESC
    LIMIT $8 OFFSET $9
  `,
    [...filterArgs(filters), limit, offset],
  );
  return rows;
}
