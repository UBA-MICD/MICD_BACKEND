// Migration 013 — AI segmentation persistence & corrections (US-45).
//
// The `/api/v1/ml/segmentation` mock produces a candidate mask but persists
// nothing. US-45 lets a validator correct what the model segmented wrong, so we
// need somewhere to store both the model's candidate and the human corrections.
//
// - `ml_segmentations`          — one row per persisted candidate (the model's
//   output). The row is mutable only in its review columns (status / reviewed_*);
//   the mask itself is never overwritten, preserving the original for traceability.
// - `ml_segmentation_corrections` — append-only. Each correction is a new row;
//   `corrects_id` chains it to the previous one, so the full edit history (who /
//   when) survives. Mirrors the `study_validations` audit-chain pattern (010).

const DDL = `
  CREATE TABLE IF NOT EXISTS ml_segmentations (
    id            SERIAL      PRIMARY KEY,
    study_id      TEXT,
    instance_id   TEXT        NOT NULL,
    series_id     TEXT,
    model_id      TEXT,
    model_version TEXT,
    prompt        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    mask_rle      JSONB,
    mask_shape    JSONB,
    status        TEXT        NOT NULL DEFAULT 'candidate',
    error_code    TEXT,
    created_by    INTEGER     NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by   INTEGER     REFERENCES users(id),
    reviewed_at   TIMESTAMPTZ,

    CONSTRAINT ml_segmentations_status_check
      CHECK (status IN ('candidate', 'accepted', 'corrected', 'discarded', 'failed'))
  );

  CREATE INDEX IF NOT EXISTS idx_ml_segmentations_study_instance
    ON ml_segmentations (study_id, instance_id);

  CREATE TABLE IF NOT EXISTS ml_segmentation_corrections (
    id              SERIAL      PRIMARY KEY,
    segmentation_id INTEGER     NOT NULL REFERENCES ml_segmentations(id),
    study_id        TEXT,
    instance_id     TEXT        NOT NULL,
    corrected_rle   JSONB       NOT NULL,
    mask_shape      JSONB       NOT NULL,
    edit_summary    JSONB,
    corrects_id     INTEGER     REFERENCES ml_segmentation_corrections(id),
    created_by      INTEGER     NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_seg_corrections_segmentation_id
    ON ml_segmentation_corrections (segmentation_id);

  CREATE INDEX IF NOT EXISTS idx_seg_corrections_created_at
    ON ml_segmentation_corrections (created_at DESC);
`;

export const migration013 = {
  id: "013_segmentations",
  sql: DDL,
};
