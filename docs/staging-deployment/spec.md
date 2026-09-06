# Staging Deployment — Specification

> SDD artifact 1 of 3 — **the "what" and "why".** Design lives in [`plan.md`](./plan.md);
> the ordered work lives in [`tasks.md`](./tasks.md). This file is the source of truth for
> *requirements and acceptance criteria*; do not put implementation detail here.

## 1. Summary

Stand up a **staging environment** for the MICD platform on a **single 4 GB VPS** that hosts
both the browser frontend and the backend behind one lightweight edge router, with **automatic,
CI-gated deployments** triggered by merges into a `staging` branch, and configure the **desktop
client** to ship pointing at that staging server.

Modelled on the sibling `is2/granBazaar` project (self-hosted deploy pipelines to a VPS via
GHCR + SSH), adapted to MICD's simpler architecture (the web tier already reverse-proxies the API
on the same origin) and to a tight resource budget.

## 2. Scope

Three repositories, one GitHub org (`UBA-MICD`):

| Repo (GitHub)        | Local path  | Role in staging                                             |
| -------------------- | ----------- | ---------------------------------------------------------- |
| `MICD_WEB`           | `web/`      | Frontend (static SPA) **+ the edge router** (Caddy)        |
| `MICD_BACKEND`       | `backend/`  | Backend API + Postgres + Orthanc (all internal)           |
| `MICD_APP`           | `desktop/`  | Client installers, built pointing at the staging server   |

**In scope:** `Dockerfile.staging`, `docker-compose.staging.yml`, `.env.staging.example`, a
`staging` branch, and an auto-deploy pipeline per repo; the Caddy edge; desktop build-time server
configuration.

**Out of scope:** production environment, monitoring/observability stack, DICOM modality C-STORE
ingress, multi-node/HA, blue-green deploys, DB backup automation (noted as a follow-up risk).

## 3. Confirmed decisions (drove this spec)

| # | Decision                | Choice                                                                   |
| - | ----------------------- | ------------------------------------------------------------------------ |
| D1 | Topology               | Single public edge router; backend + Postgres + Orthanc stay internal    |
| D2 | TLS / domain           | Domain + automatic HTTPS (Let's Encrypt)                                  |
| D3 | Router technology      | **Caddy** (auto-HTTPS, ~5-line config, low RAM; no Traefik/Kong)         |
| D4 | Deploy trigger         | After **CI passes on `staging`** (`workflow_run` chain), not on raw push  |
| D5 | Image build location   | **GitHub-hosted runners** build+push to GHCR; the VPS only pulls & runs   |
| D6 | Desktop server config  | Bake staging URL as **default** API origin at build; still overridable   |

## 4. Constraints

- **C1 — Memory.** Total VPS RAM ≈ 4 GB. The running stack (all services + OS + Docker) must fit
  comfortably with headroom. Orthanc is the dominant consumer and must be capped.
- **C2 — Minimalism.** Prefer small images (`alpine`/distroless-ish) and avoid heavyweight tooling
  (no Traefik/Kong, no in-VPS image builds).
- **C3 — No self-attribution in commits/PRs** (no `Co-Authored-By`/assistant trailers).
- **C4 — Multi-step work on a descriptive branch, one commit per completed step.**
- **C5 — Postgres tag hazard.** The `postgres:16-alpine` tag is contaminated in this workspace by
  a marketplace image that seeds a conflicting `users` table; staging **must** pin the stock
  `postgres:16` **by digest** (as `docker-compose.prod.yml` already does).
- **C6 — Backend fails fast.** With `NODE_ENV=production`, `config/env.ts` throws unless real
  `JWT_SECRET`/`JWT_REFRESH_SECRET` (and other required secrets) are set — no placeholders.

## 5. User stories & acceptance criteria (EARS)

### US-1 — One-command-less deploy on merge to staging
As a developer, when I merge a PR into `staging`, the corresponding service redeploys automatically.

- **AC-1.1** WHEN a pull request is merged into `staging` in `MICD_WEB` / `MICD_BACKEND`, the CI
  workflow SHALL run once, and on success the deploy workflow SHALL build+push the image to GHCR and
  redeploy it on the VPS.
- **AC-1.2** WHEN CI concludes with failure on `staging`, the deploy workflow SHALL NOT run.
- **AC-1.3** The deploy SHALL be manually re-runnable via `workflow_dispatch`.

### US-2 — Public HTTPS access through one edge
As a user, I can reach the staging web app over HTTPS at the staging domain, and its API calls work.

- **AC-2.1** The system SHALL serve the SPA at `https://<staging-domain>/` with a valid,
  auto-renewing Let's Encrypt certificate.
- **AC-2.2** WHEN the SPA calls `/api/*` or `/auth/*`, the edge SHALL route those to the backend and
  route all other paths to the frontend.
- **AC-2.3** Postgres, Orthanc, and the backend SHALL NOT publish any host port (reachable only on
  the internal Docker network).
- **AC-2.4** WHEN a request arrives over HTTP, the edge SHALL redirect it to HTTPS.

### US-3 — Fits the 4 GB box
As the operator, the whole stack runs within the VPS's resources.

- **AC-3.1** Every service SHALL declare a memory limit; the sum of limits SHALL leave ≥ ~1.5 GB
  headroom on a 4 GB host (see budget in `plan.md`).
- **AC-3.2** Images SHALL be built on GitHub runners; the VPS SHALL never compile/build an image.

### US-4 — Reproducible configuration
As an operator, I know exactly which values a deploy needs.

- **AC-4.1** Each deployable repo SHALL provide a committed `.env.staging.example` enumerating every
  required variable with a comment and, for secrets, a generation hint — and no real secret values.
- **AC-4.2** Required GitHub secrets/variables SHALL be documented in `plan.md`.

### US-5 — Desktop targets staging by default
As a tester, the desktop installer connects to the staging server out of the box.

- **AC-5.1** WHEN `MICD_APP` is built by its staging pipeline, the installer SHALL default its API
  origin to the staging server URL.
- **AC-5.2** The user SHALL still be able to override the API origin in-app (existing
  `electron-store` seam), and that override SHALL win over the baked default.

### US-6 — No wasted pipeline runs
As a maintainer, pipelines don't run redundantly.

- **AC-6.1** CI SHALL cancel superseded in-progress runs for the same branch/PR
  (`concurrency` + `cancel-in-progress`).
- **AC-6.2** CI SHALL skip draft PRs and docs-only changes (`paths-ignore`).
- **AC-6.3** The deploy SHALL be driven by a single trigger (CI completion on `staging`), never by
  both a push and a PR event for the same change, and SHALL serialize deploys
  (`concurrency: deploy-staging`).

## 6. Risks & mitigations

| Risk                                                   | Mitigation                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Orthanc OOMs the 4 GB box under load                   | Cap `orthanc` at ~1 GB; document tuning; staging is low-traffic  |
| Postgres tag collision breaks first boot (C5)          | Pin stock `postgres:16` by digest                                |
| Secrets committed by accident                          | Only `*.example` committed; `.env.staging` git-ignored + on VPS  |
| Web deploy races ahead of backend (edge → 502 on /api) | Both deploys `docker network create micd || true`; 502 is transient until backend is up |
| No DB backup in staging                                | Accepted for staging; flagged as follow-up                       |
| Cert issuance fails if DNS not pointed before deploy   | Prereq: point `A` record at the VPS before first deploy (plan §7) |

## 7. Resolved decisions (were open questions)

- **OQ-1 → RESOLVED.** Desktop's staging deliverable is **a pipeline that builds the executables
  for Windows and Linux** (pointed at staging via the baked default). No server artifact
  (`Dockerfile.staging`/compose) for desktop.
- **OQ-2 → RESOLVED.** The `staging` branch is based off **`dev`** in every repo.
- **OQ-3 → RESOLVED.** Staging domain is **`dicomviewermed.online`**. Its `A` record must point at
  the VPS before the first web deploy (for ACME). VPS IP supplied as a GitHub secret at deploy time.
