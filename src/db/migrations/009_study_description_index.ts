/**
 * Migration 009 — GIN trigram index on study_description for US-14 free-text
 * description filtering. The column already exists (added in 001); this migration
 * only adds the index so ILIKE '%term%' on study_description stays fast at scale.
 *
 * pg_trgm is already enabled by migration 001, so no extension step is needed.
 */
export const migration009 = {
  id: "009_study_description_index",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_studies_study_description_trgm
      ON studies USING gin (study_description gin_trgm_ops);
  `,
};
