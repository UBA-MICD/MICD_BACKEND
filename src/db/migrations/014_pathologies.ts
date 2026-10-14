// Migration 014 — Pathology classification catalog + study FK.
//
// A backend-owned lookup of pathology categories. Each row is a stable machine
// `key` (VARCHAR(15) — the longest key, "desmielinizante", is exactly 15) and
// nothing else: human labels live in the web client, keyed by `key`, so the
// backend never stores descriptions. Studies reference a category by id, so an
// upload can only carry a valid catalog id — never free text.
//
// Idempotent: CREATE TABLE IF NOT EXISTS, seed with ON CONFLICT DO NOTHING, and
// ADD COLUMN IF NOT EXISTS (which also skips the FK once the column exists).

export const migration014 = {
  id: "014_pathologies",
  sql: [
    `CREATE TABLE IF NOT EXISTS pathologies (
       id  SERIAL PRIMARY KEY,
       key VARCHAR(15) NOT NULL UNIQUE
     );`,
    `INSERT INTO pathologies (key) VALUES
       ('acv'), ('hemorragia'), ('tumor'),
       ('desmielinizante'), ('normales'), ('otros')
     ON CONFLICT (key) DO NOTHING;`,
    `ALTER TABLE studies
       ADD COLUMN IF NOT EXISTS classification_id INTEGER REFERENCES pathologies(id);`,
  ],
};
