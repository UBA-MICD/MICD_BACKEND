# Tasks: [FEATURE NAME]

> **Spec:** `specs/NNN-slug/spec.md` · **Plan:** `specs/NNN-slug/plan.md`

Ordered, checkboxed, small enough to review one at a time. `[P]` marks tasks that
can run in parallel (touch different files, no ordering dependency). Prefer writing
or updating the acceptance test before the code it verifies.

## Phase 0 — Setup

- [ ] T001 Branch off `dev`: `feat/tk-NN-slug` (in each affected repo).

## Phase 1 — Tests / acceptance first

- [ ] T010 Encode acceptance in `specs/NNN-slug/NNN-slug.feature`.
- [ ] T011 [P] Add/adjust unit tests for new pure logic.

## Phase 2 — Implementation

- [ ] T020 …
- [ ] T021 [P] …
- [ ] T0xx i18n: add keys to `src/i18n/locales/es.ts` and `en.ts` (both).

## Phase 3 — Desktop parity

- [ ] T030 `make sync-web` in `desktop/`.
- [ ] T031 `make parity` prints match.
- [ ] T032 `npm run build` && `npm test` (desktop).

## Phase 4 — Verify & deliver

- [ ] T040 `npm run build` && `npm test` (web) green.
- [ ] T041 Manual check of the headline `.feature` scenarios.
- [ ] T042 Commit (with required trailers) and push the branch(es).
