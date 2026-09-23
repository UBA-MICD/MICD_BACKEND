# Tasks: Study pathology classification (backend)

> **Spec:** `specs/001-study-classification/spec.md` · **Plan:** `specs/001-study-classification/plan.md`

## Phase 0 — Setup

- [ ] T001 Branch off `dev`: `feat/tk-NN-study-classification`.

## Phase 1 — Tests / acceptance first

- [ ] T010 Encode acceptance in `specs/001-study-classification/001-study-classification.feature`.
- [ ] T011 [P] Unit test `tests/unit/upload/classification.test.ts` for the `classification_id` parse/validate helper (integers pass; `""`/`"abc"`/`"1.5"` rejected).

## Phase 2 — Implementation

- [ ] T020 Migration `src/db/migrations/014_pathologies.ts` — create `pathologies (id, key VARCHAR(15) UNIQUE)`, seed the 6 keys (`ON CONFLICT DO NOTHING`), add `studies.classification_id INTEGER REFERENCES pathologies(id)`; register in `src/db/migrate.ts`.
- [ ] T021 New module `src/modules/pathologies/` — `repository` (`listPathologies`, `pathologyExists`), thin `service`, `controller` (GET), `routes`.
- [ ] T022 `src/app.ts` — mount the router at `/api/v1/pathologies`.
- [ ] T023 `upload.controller.ts` — parse + integer-validate `req.body.classification_id` (400 on non-integer), pass to service.
- [ ] T024 `upload.service.ts` — `pathologyExists` check (400 on unknown id), set `metadata.classificationId`.
- [ ] T025 `upload.repository.ts` — `StudyMetadata.classificationId` + `upsertStudy` columns/VALUES/ON CONFLICT/params.
- [ ] T026 `studies.repository.ts` — `LEFT JOIN pathologies` + `MAX(s.classification_id)`, `MAX(p.key)` in `findStudies`.
- [ ] T027 [P] `src/openapi.ts` — `Pathology` schema + `GET /api/v1/pathologies` path; `Study` schema `classification_id`/`classification_key`; upload request-body `classification_id`.
- [ ] T028 Integration tests — `tests/integration/pathologies.integration.test.ts` (catalog list) + extend `tests/integration/upload.integration.test.ts` (valid id round-trip, invalid id 400, omitted null).

## Phase 3 — Desktop parity

- [ ] _N/A — backend API; `desktop/backend/` is a manual copy, not synced here._

## Phase 4 — Verify & deliver

- [ ] T040 `npm run test:unit` green; `make test-integration-docker` green.
- [ ] T041 Manual: `GET /api/v1/pathologies` lists 6; `curl` upload with a valid id → listing shows it.
- [ ] T042 Commit (with required trailers) and push the branch.
