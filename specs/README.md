# Specs — Spec-Driven Development for MICD (backend)

This directory holds **feature specs** for the MICD backend (MICD_BACKEND —
Express + PostgreSQL + Orthanc), following the
[GitHub Spec Kit](https://github.com/github/spec-kit) approach: every non-trivial
feature is described (WHAT/WHY), designed (HOW) and broken into tasks **before** it
is implemented. Code follows the spec, not the other way around.

The principles every spec must honour live in
[`.specify/memory/constitution.md`](../.specify/memory/constitution.md).

## The workflow

```
specify  →  plan  →  tasks  →  implement
 spec.md    plan.md   tasks.md    the code
 WHAT/WHY   HOW       ordered     follows the tasks
```

1. **`/specify` → `spec.md`** — requirements, user stories, acceptance criteria.
   No implementation detail. Unknowns are marked `[NEEDS CLARIFICATION]`.
2. **`/plan` → `plan.md`** — the technical design: routes/models to touch, existing
   modules to reuse, testing strategy, and a **constitution check**.
3. **`/tasks` → `tasks.md`** — an ordered, checkboxed task list (`[P]` = parallel).
4. **`/implement`** — execute the tasks; keep the spec/tasks updated if reality
   diverges.

> Templates for each artifact are in [`.specify/templates/`](../.specify/templates/).

## Index

| # | Feature | Status | Ticket |
|---|---------|--------|--------|
| — | _(no backend specs yet)_ | — | — |

Existing backend BDD/acceptance material lives under [`docs/`](../docs/) (e.g.
`docs/tk-06-audit-log.feature`, `docs/us-21-rbac-plan.md`); new backend features
should adopt the `specs/NNN-slug/` structure above going forward.

## Multi-repo rule

The **constitution and templates** (`.specify/`) are system-level and kept
**identical** across `web`, `backend` and `desktop`, like the ADRs. Backend feature
specs live here; front-end specs live in `web`; a system-wide spec that spans both is
mirrored across the repos it affects.
