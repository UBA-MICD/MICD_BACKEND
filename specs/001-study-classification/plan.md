# Plan: Study pathology classification (backend)

> **Spec:** `specs/001-study-classification/spec.md` · **Ticket:** TK-NN · **Date:** 2026-09-22

## Summary

Add a normalized **`pathologies`** lookup table (`id`, `key VARCHAR(15)`), seeded in-migration with
the 6 category keys; expose it read-only at `GET /api/v1/pathologies`; add a nullable
`studies.classification_id` **foreign key** set from an optional `classification_id` form field on
upload; and return `classification_id` + the joined `classification_key` from the `v1` listing. The
catalog is the single source of allowed categories — validity is enforced by an existence check plus
the DB foreign key, so uploads carry an id, never free text.

## Constitution check

- **Plain platform / no new dep:** raw `pg` + one numbered idempotent migration; no ORM, no library.
- **Desktop parity / vendoring:** N/A (API).
- **i18n parity:** N/A — backend returns only the `key`; labels are the web's concern.
- **Accessibility:** N/A.
- **Security (escaping, API surface, role gating):** integer FK validated against the catalog (clean 400) with the DB foreign key as backstop; catalog read behind `requireAuth`; upload write path role-gated (`admin`/`medico`) as today; not PHI.
- **Tests:** don't mock `pool` — a small unit test for the id parse/validation + integration tests (catalog list, upload round-trip, invalid id) against the live stack.

## Existing code to reuse

- `src/db/migrations/002_auth.ts` — precedent for **seeding rows inside a migration** (the test user is seeded in SQL); the `pathologies` seed follows the same idea with `INSERT … ON CONFLICT (key) DO NOTHING`.
- `src/db/migrations/012_study_metadata.ts` — idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` template; `src/db/migrate.ts` registration pattern.
- `src/modules/studies/*` (routes → controller → service → repository) — the layering shape to copy for the tiny new `pathologies` module.
- `src/modules/upload/{upload.controller,upload.service,upload.repository}.ts` — the `controller → service → upsertStudy` path to thread `classification_id` through.
- `src/modules/studies/studies.repository.ts:164-208` (`findStudies`) — the aggregated listing SELECT to extend with a `LEFT JOIN pathologies`.
- `src/app.ts` — where module routers are mounted; add the `pathologies` router.

## Design

**Catalog.** `pathologies (id SERIAL PRIMARY KEY, key VARCHAR(15) NOT NULL UNIQUE)`, seeded with the
6 keys (`desmielinizante` is exactly 15 chars — the column width is deliberate). A tiny
`modules/pathologies/` module (routes/controller/service/repository) serves
`GET /api/v1/pathologies → [{ id, key }]` ordered by id, behind `requireAuth`. The `service`/`repository`
also expose `pathologyExists(id)` reused by the upload validation.

**Write.** Upload is `multipart/form-data`; multer memory storage populates `req.body` alongside
`req.file`. The upload **controller** reads `req.body.classification_id`, coerces to an integer
(reject non-integers with 400), and passes it (or `null`) to the **service**, which calls
`pathologyExists(id)` (400 if absent) then sets `metadata.classificationId` before `repo.upsertStudy`.
`upsertStudy` stores it on each per-instance row; every file in one study upload carries the same id,
so all rows agree, and the DB foreign key is the final integrity backstop. Legacy
`POST /api/instances` shares the handler, so it gets the field for free. `ON CONFLICT DO UPDATE`
means a `?force` re-upload updates the id (see spec open question).

**Read.** `findStudies` gains `LEFT JOIN pathologies p ON p.id = s.classification_id` and returns
`MAX(s.classification_id) AS classification_id` and `MAX(p.key) AS classification_key` within the
existing per-`orthanc_study_id` aggregation — no GROUP BY change.

## Affected files

- `src/db/migrations/014_pathologies.ts` **(new)** — `CREATE TABLE IF NOT EXISTS pathologies (…)`; `INSERT … ON CONFLICT (key) DO NOTHING` seed; `ALTER TABLE studies ADD COLUMN IF NOT EXISTS classification_id INTEGER REFERENCES pathologies(id)`.
- `src/db/migrate.ts` — import `migration014`, append to the `migrations` array.
- `src/modules/pathologies/pathologies.repository.ts` **(new)** — `listPathologies()`, `pathologyExists(id)`.
- `src/modules/pathologies/pathologies.service.ts` **(new, thin)** — passes through to the repository.
- `src/modules/pathologies/pathologies.controller.ts` **(new)** — `GET` handler → `200 [{id,key}]`.
- `src/modules/pathologies/pathologies.routes.ts` **(new)** — `router.get("/", requireAuth, …)`.
- `src/app.ts` — mount `pathologies.routes` at `/api/v1/pathologies`.
- `src/modules/upload/upload.controller.ts` — parse + integer-validate `req.body.classification_id`, pass to service.
- `src/modules/upload/upload.service.ts` — accept the arg, `pathologyExists` check (400), set `metadata.classificationId` (default `null`).
- `src/modules/upload/upload.repository.ts` — add `classificationId` to `StudyMetadata` and to the `upsertStudy` INSERT columns / `VALUES` / `ON CONFLICT DO UPDATE` / params.
- `src/modules/studies/studies.repository.ts` — `LEFT JOIN pathologies` + `MAX(s.classification_id)`, `MAX(p.key)` in `findStudies`.
- `src/openapi.ts` — add a `Pathology` schema and the `GET /api/v1/pathologies` path; add `classification_id` + `classification_key` (nullable) to the `Study` schema; add optional `classification_id` to the upload request body.

## Testing strategy

- **Unit** (jest, `tests/unit/upload/classification.test.ts`): the id parse/validate helper — integer strings → number; `""`/`"abc"`/`"1.5"` → rejected/`null`.
- **Integration** (`tests/integration/pathologies.integration.test.ts` new + extend `tests/integration/upload.integration.test.ts`): `GET /api/v1/pathologies` returns the 6 keys with ids; upload a sample DICOM with a valid `classification_id` → `201` → listing shows matching `classification_id`/`classification_key`; invalid id → `400`; omitted → `null`. Model on `tests/integration/validation.integration.test.ts` (auth helpers, round-trip through the listing).
- **Manual / BDD:** the `001-study-classification.feature` scenarios; `curl -F file=@sample.dcm -F classification_id=<id> …/api/v1/studies/upload`.

## Desktop parity steps

N/A (backend API). `desktop/backend/` is a manual, non-synced copy — out of scope for this change.

## Rollout / delivery

Branch `feat/tk-NN-study-classification` off `dev`. Migration `013` (table + seed + FK column)
applies automatically on the next `make up` / container start (no migrate CLI). Verify with
`make test-integration-docker` (self-contained). Commit with the required trailers; push the branch.
