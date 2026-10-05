# Staging Deployment — Task Breakdown

> SDD artifact 3 of 3 — **the ordered work.** Requirements: [`spec.md`](./spec.md); design:
> [`plan.md`](./plan.md). Each task cites the AC/§ it satisfies. Per constraint C4, do the work on a
> descriptive branch per repo and **commit after each completed task** (no self-attribution, C3).

Branch name (all repos): `feat/staging-deployment`, based off `dev` (pending OQ-2).

Legend: ☐ todo — each is independently reviewable/committable.

---

## Phase 0 — Foundations (shared)

- ☑ **T0.1** Open questions resolved: desktop = installer build (Win+Linux); branch base `dev`;
  domain `dicomviewermed.online`. (spec §7)
- ☑ **T0.2** Create `feat/staging-deployment` branch (off `dev`) in each of the three repos.

## Phase 1 — Backend data plane (`MICD_BACKEND`)  → US-1, US-2 (AC-2.3), US-3, US-4

- ☑ **T1.1** Add `Dockerfile.staging` (mirror existing `Dockerfile` runtime target). — plan §3.2
- ☑ **T1.2** Add `docker-compose.staging.yml`: postgres (digest-pinned stock 16, C5) + orthanc
  (digest-pinned) + backend (GHCR image), **no host ports**, memory limits per plan §2, network
  `micd`, `TLS_ENABLED=false`. — AC-2.3, AC-3.1, C5
- ☑ **T1.3** Add `.env.staging.example` (from `.env.prod.example`, staging-tuned, no host-port
  vars). — AC-4.1
- ☑ **T1.4** Update `ci.yml`: add `staging` to `push`/`pull_request`; add `concurrency` +
  `cancel-in-progress`, draft guard, `paths-ignore: [docs/**]`. — AC-6.1, AC-6.2
- ☑ **T1.5** Add `.github/workflows/deploy-to-staging.yml` (build-push → GHCR, then SSH deploy +
  `/api/readyz` health check). — AC-1.1, AC-1.2, AC-1.3, AC-6.3, AC-3.2
- ☑ **T1.6** Add `docs/staging/README.md` pointer back to this spec set.

  _Done — committed on `feat/staging-deployment` (backend); compose validated with `docker compose config`._

## Phase 2 — Frontend + edge router (`MICD_WEB`)  → US-1, US-2, US-3, US-4

- ☑ **T2.1** Add `Dockerfile.staging` (node build → `nginx:1.27-alpine` static). — plan §3.1
- ☑ **T2.2** Add `Caddyfile` (TLS + `/api`,`/auth`→backend, `/`→web). — AC-2.1, AC-2.2, AC-2.4
- ☑ **T2.3** Add `docker-compose.staging.yml`: `caddy` (80/443 + cert volumes + Caddyfile mount) and
  `web` (GHCR image, alias `web`, no host ports), network `micd`, limits per plan §2. — AC-2.1–2.4, AC-3.1
- ☑ **T2.4** Add `.env.staging.example` (`STAGING_DOMAIN`, `ACME_EMAIL`, `WEB_IMAGE`). — AC-4.1
- ☑ **T2.5** Update `ci.yml` (staging trigger + concurrency/guards/paths-ignore). — AC-6.1, AC-6.2
- ☑ **T2.6** Add `.github/workflows/deploy-to-staging.yml` (build-push → GHCR; SSH deploy copies
  compose + Caddyfile; HTTPS/200 health check). — AC-1.x, AC-6.3, AC-3.2
- ☑ **T2.7** Add `docs/staging/README.md` pointer.

  _Done — committed on `feat/staging-deployment` (web); compose validated + `caddy validate` passed._

## Phase 3 — Desktop client build (`MICD_APP`)  → US-5 (pending OQ-1)

- ☑ **T3.1** Add `scripts/gen-build-config.sh` writing `src/main/build-config.generated.ts` from
  `MICD_DEFAULT_API_ORIGIN` (fallback `http://localhost:3000`); git-ignore the generated file. — plan §3.3
- ☑ **T3.2** Wire codegen via `prebuild`/`pretest` hooks (before `tsc`/tests); point
  `shared-config.ts`'s `DEFAULT_API_ORIGIN` at `BUILD_DEFAULT_API_ORIGIN`; `preload.ts` uses
  `resolveApiOrigin`. — AC-5.1
- ☑ **T3.3** Add `shared-config.test.ts`: baked default honored + in-app override wins. — AC-5.2
- ☑ **T3.4** Add `.env.staging.example` documenting `MICD_DEFAULT_API_ORIGIN`. — AC-4.1
- ☑ **T3.5** Update `ci.yml` (staging trigger + concurrency/guards).
- ☑ **T3.6** Add `.github/workflows/deploy-to-staging.yml` — CI-completion-on-`staging` triggered
  Win+Linux installer build with `MICD_DEFAULT_API_ORIGIN` from a repo variable; upload artifacts. — AC-1.1, AC-5.1
- ☑ **T3.7** Add `docs/staging/README.md` pointer.

  _Done — committed on `feat/staging-deployment` (desktop); `tsc --noEmit` + unit tests pass in container._

## Phase 4 — Provisioning & first deploy (operator)  → US-2, US-3, US-4

- ☐ **T4.1** Point the staging domain `A` record at the VPS (OQ-3). — plan §6
- ☐ **T4.2** Install Docker + Compose on the VPS; `docker network create micd`. — plan §6
- ☐ **T4.3** Create `STAGING_VPS_PATH/{backend,web}/.env.staging` from examples; fill secrets. — C6
- ☐ **T4.4** Add GitHub secrets/variables to each repo (plan §5). — AC-4.2
- ☐ **T4.5** Open `staging` PRs (or `workflow_dispatch`) and verify first deploys of backend, then
  web. — AC-1.1

## Phase 5 — Verification  → all US

- ☐ **T5.1** Run the validation checklist (plan §8): HTTPS + cert, HTTP→HTTPS redirect, `/api/livez`
  through the edge, no host ports on internal services, `docker stats` within budget.
- ☐ **T5.2** Confirm no-wasted-runs: merge triggers exactly one CI + one deploy; failed CI blocks
  deploy; draft PR triggers nothing. — US-6
- ☐ **T5.3** Install a desktop staging build; confirm it targets staging and can be re-pointed. — US-5
- ☐ **T5.4** Merge the `feat/staging-deployment` branches once verified.

---

### Suggested execution order

Phase 1 → Phase 2 (backend data plane must exist for the edge to route `/api`), Phase 3 in parallel,
then Phase 4 → Phase 5. Within each repo, tasks are ordered so each commit builds on the last.
