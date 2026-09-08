# MICD Constitution

The non-negotiable principles that govern how the UBA-MICD system (DICOM study
management for the Hospital de Clínicas — Trabajo Profesional) is built across its
three repositories: **MICD_WEB** (`web/`), **MICD_BACKEND** (`backend/`) and the
Electron client (`desktop/`).

This document is **system-level and identical in all three repos** — the same
replication rule the ADRs follow (`docs/adr/README.md`). It governs the
Spec-Driven-Development workflow described in `specs/README.md`: every spec, plan
and task set must comply with the principles below, and a plan that violates one
must either be revised or justified by a new ADR.

---

## Core principles

### I. Local viewing is free; the server is one deliberate step away

Opening and viewing local DICOM files never requires a session — the app always
starts, and `startApp()` runs before any auth attempt. Everything that touches the
server (search, upload, admin) lives behind a single, clearly-labelled step that
leaves the viewer for the dedicated server screen. There is no login modal thrown
over an image; a guest, or a session that dies mid-operation, lands on the server
screen's auth card. Features must preserve this separation.

### II. Plain platform, no new runtime dependencies

The web/desktop client is plain TypeScript compiled straight to `dist/` by `tsc`
— no framework, no bundler. The backend is Express + PostgreSQL + Orthanc. **A new
runtime dependency is a decision, not a convenience:** it requires an ADR. Prefer a
small amount of in-house code over vendoring a library that is heavier than the
logic it replaces. The web client currently ships exactly two runtime deps
(`dicom-parser`, `fflate`) and that bar is defended on purpose.

### III. Desktop parity by vendoring — never hand-edit the renderer

`web/src` is the single source of truth for the client. `desktop/src/renderer` is a
**verbatim vendored copy** kept in sync by `make sync-web`; `make parity`
(`diff -r`) must be empty. Any behaviour that must differ under Electron goes
through a feature-detected seam (`shared/token-store.ts`, `shared/desktop.ts`,
`services/export-service.ts`, `window.MICD_API_ORIGIN`), never an Electron branch in
a feature file. A front-end change lands in `web` first and is re-vendored into
`desktop` in the same logical change.

### IV. Bilingual by construction

The UI ships in Spanish (default) and English. All copy goes through `t()` /
`data-i18n`; `es.ts` and `en.ts` must carry **identical key sets** — `i18n.test.ts`
fails otherwise. Dynamically-rendered markup re-renders on `onLocaleChange`. Adding
a user-visible string means adding the key to both locale files.

### V. Accessibility is a release gate, not a polish pass

The UI targets WCAG 2.2 AA. Contrast is measured (recorded in `styles.css`), state
that is visual is also programmatic (`aria-*` keyed off by CSS where possible),
every group is one tab stop (`shared/roving.ts`), every modal traps and restores
focus (`shared/dialog.ts`), and live regions are rationed. A feature that adds UI
states its keyboard and screen-reader behaviour in its spec.

### VI. Security: escape everything, least privilege, one API surface

Every interpolation of DICOM-derived or user-supplied data is escaped
(`escapeHtml`/`escapeAttr`); `data-i18n-html` is only for trusted app-authored
markup. The front-end talks **only** to the backend's `/api/*` and `/auth/*` — never
to Postgres/Orthanc directly. Access is role-gated (`admin` / `medico` /
`investigador`, guests) and the client hides what a role cannot use *and* the
backend enforces it. JWT: short-lived in-memory access token, rotated refresh token.

### VII. Tested where it counts, DOM-free where it can be

Pure logic is unit-tested with `tsx --test` / `node:test` and kept DOM-free so it
runs under the bare runner; DOM behaviour uses the jsdom setup. New pure logic
ships with tests. Tests must pass in both `web` and the vendored `desktop` copy.

### VIII. Decisions are recorded; features are specified

Architectural decisions are captured as **immutable ADRs** (`docs/adr/`) — a
decision is changed by writing a new ADR that supersedes the old one, never by
editing it. Features are captured as **specs** (`specs/`, this SDD workflow) before
they are built. Acceptance criteria are expressed as Gherkin `.feature` files. ADRs,
constitution and system-level specs are kept identical across the repos they affect.

### IX. Containerized per repo

Each repo builds and runs standalone via Docker (Dockerfile + compose + `.env` +
Makefile). The backend's compose creates the external `micd` network the web
container joins, so the backend stack starts first.

---

## Governance

- **Authority.** This constitution supersedes ad-hoc practice. A spec or plan that
  conflicts with a principle here is non-compliant; the "Constitution check" section
  of the plan template exists to catch this before implementation.
- **Amendment.** Principles change only through an ADR that records the decision and
  its cost, followed by a version bump here and a same-PR update to the identical
  copies in the other repos. The constitution itself is versioned, not immutable —
  but every change leaves an ADR trail.
- **Compliance.** Code review checks the change against the relevant spec and this
  constitution. "It's just a small change" is not an exemption from parity, i18n
  parity, escaping, or the accessibility gate.

**Version:** 1.0.0 · **Ratified:** 2026-09-08 · **Last amended:** 2026-09-08
