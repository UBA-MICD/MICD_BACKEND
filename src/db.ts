import { Pool } from 'pg'

export const pool = new Pool({
  host: process.env.DB_HOST ?? 'postgres',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME ?? 'micd',
  user: process.env.DB_USER ?? 'micd',
  password: process.env.DB_PASSWORD ?? 'micd',
})

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS studies (
      id                  SERIAL PRIMARY KEY,
      orthanc_study_id    TEXT NOT NULL,
      orthanc_instance_id TEXT NOT NULL,
      sop_instance_uid    TEXT UNIQUE NOT NULL,
      study_instance_uid  TEXT,
      patient_name        TEXT,
      patient_id          TEXT,
      study_date          TEXT,
      modality            TEXT,
      study_description   TEXT,
      rows_count          INTEGER,
      cols_count          INTEGER,
      uploaded_at         TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_studies_orthanc_study_id ON studies(orthanc_study_id);
    CREATE INDEX IF NOT EXISTS idx_studies_modality        ON studies(modality);
    CREATE INDEX IF NOT EXISTS idx_studies_study_date      ON studies(study_date);
    CREATE INDEX IF NOT EXISTS idx_studies_patient_name    ON studies(patient_name text_pattern_ops);
  `)
}
