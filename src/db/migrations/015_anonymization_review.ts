// Migration 015 — Anonymization review flag (TK-11).
//
// Adds two columns to `studies` for the pre-storage PHI check running in
// `warn` mode: `needs_review` marks a study a human should look at, and
// `review_findings` records WHY as a PHI-free list of {tag, name, reason,
// severity} (never the offending values). In strict mode a failing study is
// rejected and never reaches this table, so these only ever describe warnings
// or warn-mode residual findings.

export const migration015 = {
  id: "015_anonymization_review",
  sql: [
    `ALTER TABLE studies
       ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;`,
    `ALTER TABLE studies
       ADD COLUMN IF NOT EXISTS review_findings JSONB;`,
  ],
};
