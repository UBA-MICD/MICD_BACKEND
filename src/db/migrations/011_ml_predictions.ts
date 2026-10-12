// Migration 011 — ML predictions (US-ML).
//
// Adds `study_ml_predictions` to store model inference results triggered by
// an admin. Each row is the output of one analysis run on a study; the latest
// row by `analyzed_at` is the canonical current prediction.

const DDL = `
  CREATE TABLE IF NOT EXISTS study_ml_predictions (
    id           SERIAL      PRIMARY KEY,
    study_id     TEXT        NOT NULL,
    label        TEXT        NOT NULL,
    confidence   FLOAT       NOT NULL,
    analyzed_by  INTEGER     NOT NULL REFERENCES users(id),
    analyzed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_study_ml_predictions_study_id
    ON study_ml_predictions (study_id);
`;

export const migration011 = {
  id: "011_ml_predictions",
  sql: DDL,
};
