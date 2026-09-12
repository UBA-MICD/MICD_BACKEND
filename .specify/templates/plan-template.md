# Plan: [FEATURE NAME]

> **Spec:** `specs/NNN-slug/spec.md` · **Ticket:** TK-NN · **Date:** YYYY-MM-DD

A **plan describes HOW.** It turns the spec's requirements into a concrete technical
approach a developer can execute. Cite real files, functions and existing utilities
to reuse — reuse before new code.

## Summary

One paragraph: the approach in a sentence, then the shape of the change.

## Constitution check

Confirm the approach honours each relevant principle (`.specify/memory/constitution.md`).
Flag any tension and how it is resolved (or which ADR justifies it).

- **Plain platform / no new dep:** …
- **Desktop parity / vendoring:** …
- **i18n parity:** …
- **Accessibility:** …
- **Security (escaping, API surface, role gating):** …
- **Tests:** …

> If a principle is violated with no ADR, stop and write the ADR first.

## Existing code to reuse

- `path/to/file.ts` — `functionName()` does X; reuse rather than reimplement.
- …

## Design

How it works: the data/control flow, the seams touched, why this shape over the
alternatives. Keep it to what a reviewer needs to follow the change.

## Affected files

- `path/to/file` — what changes and why.
- …

## Testing strategy

- Unit (`tsx --test`): which pure logic, which cases (incl. failure paths).
- DOM / integration: what is asserted, in which fixture.
- Manual / BDD: the `.feature` scenarios that gate acceptance.

## Desktop parity steps

`web` first → in `desktop/`: `make sync-web` → `make parity` (must match) →
`npm run build` → `npm test`.

## Rollout / delivery

Branch, commits, verification, and anything to watch after merge.
