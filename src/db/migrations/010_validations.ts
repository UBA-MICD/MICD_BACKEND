// Migration 010 — Diagnostic validations (US-26).
//
// Adds the `study_validations` table to record clinical validation decisions
// (approve / reject / flag for review) made by medicos and admins on studies.
// Each row is immutable — corrections are new rows that reference the prior
// validation via `corrects_id`, forming an audit chain.
//
// The `studies` table gains a computed `validation_status` view via a JOIN in
// the repository rather than a denormalised column, so there is no update
// needed on the studies table itself.

const DDL = `
  CREATE TABLE IF NOT EXISTS study_validations (
    id          SERIAL PRIMARY KEY,
    study_id    TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    comment     TEXT,
    user_id     INTEGER     NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    corrects_id INTEGER     REFERENCES study_validations(id),

    CONSTRAINT study_validations_action_check
      CHECK (action IN ('approved', 'rejected', 'review'))
  );

  CREATE INDEX IF NOT EXISTS idx_study_validations_study_id
    ON study_validations (study_id);

  CREATE INDEX IF NOT EXISTS idx_study_validations_created_at
    ON study_validations (created_at DESC);
`;

export const migration010 = {
  id: "010_validations",
  sql: DDL,
};
