// Migration 012 — Study metadata columns (TK-12).
//
// Adds two DICOM-derived columns to `studies` that were not captured at
// upload time, and a B-tree index on study_instance_uid so queries that
// filter or join on the DICOM UID respond well under load.

export const migration012 = {
  id: "012_study_metadata",
  sql: [
    `ALTER TABLE studies ADD COLUMN IF NOT EXISTS series_description TEXT;`,
    `ALTER TABLE studies ADD COLUMN IF NOT EXISTS number_of_images INTEGER;`,
    `CREATE INDEX IF NOT EXISTS idx_studies_study_instance_uid
       ON studies (study_instance_uid);`,
  ],
};
