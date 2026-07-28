import { pool } from "../../db/pool";
import { InstanceRow } from "../../shared/instances-util";

export interface StudyFilters {
  modality: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  search: string | null;
  zenodoLinked: boolean | null;
}

// Shared WHERE clause for the paginated listing — parameterized so both the
// COUNT and the page query use identical filter semantics.
const FILTER_WHERE = `
  ($1::text IS NULL OR modality = $1)
  AND ($2::text IS NULL OR study_date >= $2)
  AND ($3::text IS NULL OR study_date <= $3)
  AND (
    $4::text IS NULL
    OR patient_name ILIKE '%' || $4 || '%'
    OR patient_id   ILIKE '%' || $4 || '%'
  )
  AND ($5::bool IS NULL OR ($5 = true AND (zenodo_doi IS NOT NULL OR zenodo_source_doi IS NOT NULL)))`;

function filterArgs(f: StudyFilters): (string | boolean | null)[] {
  return [f.modality, f.dateFrom, f.dateTo, f.search, f.zenodoLinked];
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
      SELECT orthanc_study_id FROM studies
      WHERE ${FILTER_WHERE}
      GROUP BY orthanc_study_id
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
  if (!row || (row.zenodo_doi === null && row.zenodo_source_doi === null && row.patient_name === null)) {
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
      MIN(id)                  AS id,
      orthanc_study_id,
      MIN(orthanc_instance_id) AS orthanc_instance_id,
      MAX(patient_name)        AS patient_name,
      MAX(patient_id)          AS patient_id,
      MAX(study_date)          AS study_date,
      MAX(modality)            AS modality,
      MAX(study_description)   AS study_description,
      MAX(uploaded_at)         AS uploaded_at,
      COUNT(*)                 AS num_instances,
      MAX(zenodo_doi)          AS zenodo_doi,
      MAX(zenodo_published_at) AS zenodo_published_at,
      MAX(zenodo_source_record_id) AS zenodo_source_record_id,
      MAX(zenodo_source_doi)   AS zenodo_source_doi,
      MAX(zenodo_imported_at)  AS zenodo_imported_at,
      BOOL_OR(zenodo_new_version_available) AS zenodo_new_version_available
    FROM studies
    WHERE ${FILTER_WHERE}
    GROUP BY orthanc_study_id
    ORDER BY MAX(uploaded_at) DESC
    LIMIT $6 OFFSET $7
  `,
    [...filterArgs(filters), limit, offset],
  );
  return rows;
}
