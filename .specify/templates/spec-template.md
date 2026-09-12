# Spec: [FEATURE NAME]

> **Number:** NNN · **Slug:** `NNN-short-slug` · **Ticket:** TK-NN / US-NN
> **Status:** Draft | Ready | In progress | Done · **Author:** … · **Date:** YYYY-MM-DD
> **Repos affected:** MICD_WEB | MICD_BACKEND | desktop (via vendoring)

A **spec describes WHAT and WHY, never HOW.** No file names, function signatures, or
technology choices here — those live in `plan.md`. Write it so a reviewer who does
not read code can judge whether the right thing is being built.

Mark every unknown explicitly as `[NEEDS CLARIFICATION: question]` rather than
guessing — an unresolved marker blocks the plan.

## Why (problem & motivation)

What is wrong or missing today, what it costs, and what prompted this now. One or two
paragraphs. If this fixes a concrete failure, describe the failure.

## Who (users & roles)

Which of the MICD roles this touches — `admin`, `medico`, `investigador`, guest —
and what each of them can and cannot do as a result. Be explicit about role gating.

## What (user stories)

- As a **[role]**, I want **[capability]** so that **[outcome]**.
- …

## Functional requirements

- **FR-1:** The system MUST …
- **FR-2:** The system MUST …
- **FR-3:** The system MUST NOT … *(state the guardrails, not only the happy path)*

## Acceptance criteria

Testable, in Given/When/Then form. Prefer to keep the full matrix in a sibling
`NNN-slug.feature` (Gherkin, house style) and summarise the headline scenarios here.

- **AC-1:** Given … when … then …
- **AC-2:** …

## Out of scope

What this spec deliberately does **not** change (so review does not expand it).

## Non-functional requirements (the constitution's gates)

- **i18n:** new copy in both `es.ts`/`en.ts` (parity test). Keys: …
- **Accessibility:** keyboard + screen-reader behaviour of any new UI.
- **Security:** what is escaped / role-enforced; no new direct data-store access.
- **Desktop parity:** front-end changes vendor into `desktop` unchanged.
- **Performance / offline:** any constraint (no CDN, bundle size, etc.).

## Open questions

- `[NEEDS CLARIFICATION: …]`

## Review checklist

- [ ] No implementation detail (no HOW) leaked in.
- [ ] Every requirement is testable and unambiguous.
- [ ] Role gating stated for each affected role.
- [ ] Constitution gates (i18n, a11y, security, parity) addressed.
- [ ] No unresolved `[NEEDS CLARIFICATION]` markers.
