# Spec: Study pathology classification (backend)

> **Number:** 001 · **Slug:** `001-study-classification` · **Ticket:** TK-NN _(to assign)_
> **Status:** Draft · **Author:** Nacho · categories defined by María Emilia Ruiz (Hospital) · **Date:** 2026-09-22
> **Repos affected:** MICD_BACKEND _(paired with MICD_WEB spec `005-study-classification`)_

## Why (problem & motivation)

Studies are persisted with DICOM-derived metadata only (patient, date, modality, description…).
The hospital needs every study tagged with a **pathology category** so the archive can be grouped
and reviewed by pathology.

The category list is **owned by the backend as a lookup table**, not hardcoded on either side: the
backend stores only a stable machine `key` per category (no human descriptions), the client fetches
the catalog and renders/translates the labels. A study references a category by **id** (a foreign
key), so an upload can never carry free text — only a valid catalog id — and categories can be added
or renamed without changing application code.

## Who (users & roles)

- **admin, medico:** set the classification when uploading (upload is already gated to these two roles).
- **investigador:** read-only — fetches the catalog and sees the classification in the listing, cannot set it.
- **guest:** no server access.

## What (user stories)

- As a **client (any authenticated role)**, I want to fetch the catalog of pathology categories so I can offer them in the upload UI and translate their labels.
- As a **medico/admin**, I want to attach a category (by id) to a study at upload so it is stored with the study metadata.
- As an **authenticated user**, I want the study's category returned by the listing (id + key) so the client can display and translate it.

## Functional requirements

- **FR-1:** The system MUST expose the pathology catalog via `GET /api/v1/pathologies`, returning `{ id, key }` per category, behind `requireAuth`.
- **FR-2:** The catalog MUST be seeded with the keys `acv`, `hemorragia`, `tumor`, `desmielinizante`, `normales`, `otros`. Each `key` is unique and at most 15 characters. The backend MUST NOT store human-readable descriptions.
- **FR-3:** The upload endpoint MUST accept an **optional** `classification_id` referencing a catalog row.
- **FR-4:** The system MUST persist the study's `classification_id` (a foreign key to the catalog) with its metadata.
- **FR-5:** The system MUST reject an upload whose `classification_id` is present but not a valid catalog id (**HTTP 400**), and MUST NOT create the study. Free text is impossible by construction (the field is an integer id).
- **FR-6:** When `classification_id` is absent or blank, the study MUST be stored with a **null** classification.
- **FR-7:** `GET /api/v1/studies` MUST return each study's `classification_id` and its `classification_key`.
- **FR-8:** The catalog MUST be the single source of allowed categories — no allow-list of category strings duplicated in application code.

## Acceptance criteria

- **AC-1:** Given an authenticated client, when `GET /api/v1/pathologies`, then `200` and the body contains the 6 seeded keys, each with a numeric `id`.
- **AC-2:** Given a valid DICOM and a valid `classification_id`, when `POST /api/v1/studies/upload`, then `201` and `GET /api/v1/studies` returns that study with the matching `classification_id` and `classification_key`.
- **AC-3:** Given `classification_id=999999` (no such row), when uploading, then `400` and the study is not created.
- **AC-4:** Given `classification_id=abc` (non-integer), when uploading, then `400`.
- **AC-5:** Given no `classification_id`, when uploading, then `201` and the listing returns `classification_id: null`, `classification_key: null`.

_(full matrix in `001-study-classification.feature`)_

## Out of scope

UI (web spec `005`). Managing the catalog via API (create/rename/delete categories) — the catalog is
seeded only this iteration. Editing a study's classification after upload. Filtering the listing by
category. Classification on the legacy Orthanc proxy (`/api/studies/:id`).

## Non-functional requirements (the constitution's gates)

- **i18n:** N/A — the API returns only the stable `key`; human labels live in the web client.
- **Accessibility:** N/A — no UI.
- **Security:** the category is an integer FK validated against the catalog (400 on a bad id) with the DB foreign key as backstop; catalog read behind `requireAuth`; upload write path stays behind `requireRole("admin","medico")`. Not PHI → no redaction change.
- **Desktop parity:** N/A — `desktop/backend/` is a manual copy, not auto-synced.
- **Performance / offline:** catalog is a tiny seeded table; the study's key is returned via a `LEFT JOIN` on the existing grouped listing query — no new query shape, no N+1.

## Open questions

- `[NEEDS CLARIFICATION: ticket id]`
- `[NEEDS CLARIFICATION: should a ?force re-upload overwrite an existing study's classification_id? Default assumed: yes — ON CONFLICT DO UPDATE.]`
- `[NEEDS CLARIFICATION: is admin management of the catalog (add/rename categories via API) wanted later? Out of scope now.]`

## Review checklist

- [x] No implementation detail (no HOW) leaked in.
- [x] Every requirement is testable and unambiguous.
- [x] Role gating stated for each affected role.
- [x] Constitution gates addressed (i18n/a11y N/A for API; security stated).
- [ ] `[NEEDS CLARIFICATION]` markers resolved (ticket id, force-overwrite, catalog admin).
