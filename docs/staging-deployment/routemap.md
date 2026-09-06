# Staging Deployment — Routemap (resume from another computer)

> Handoff note so this task can be retaken on a different machine. Canonical SDD set lives
> **in this repo** (`MICD_BACKEND`): [`spec.md`](./spec.md) · [`plan.md`](./plan.md) ·
> [`tasks.md`](./tasks.md). This file = what's done, what's left, and how to pick it back up.

## Claude Code session

- **Session ID:** `6e214b67-30c5-48c4-a106-cd5a57f50a32`
- Resume with: `claude --resume 6e214b67-30c5-48c4-a106-cd5a57f50a32`
  (session transcripts are per-machine/local, so on a fresh computer just start a new
  session and point it at this routemap + the SDD set — everything needed is committed).
- Workspace layout: three sibling git repos under one parent dir —
  `web/` (`UBA-MICD/MICD_WEB`), `backend/` (`UBA-MICD/MICD_BACKEND`), `desktop/` (`UBA-MICD/MICD_APP`).
- Branch in every repo: **`feat/staging-deployment`** (based off `dev`).

> Note: the parent workspace dir is **not** a git repo, so the SDD docs were relocated from
> the old workspace-root `docs/staging-deployment/` into this repo so they travel with a clone.

## What's DONE (committed + pushed on `feat/staging-deployment`)

Phases 0–3 of [`tasks.md`](./tasks.md). Per repo:

- **backend** (`MICD_BACKEND`): `Dockerfile.staging`, `docker-compose.staging.yml`
  (postgres digest-pinned stock 16 + orthanc + backend, no host ports, 4 GB-tuned mem limits),
  `.env.staging.example`, `.github/workflows/deploy-to-staging.yml` (GHCR build-push →
  SSH deploy → `/api/readyz` check), `ci.yml` staging trigger + guards, `docs/staging/`.
- **web** (`MICD_WEB`): `Dockerfile.staging` (nginx static), `Caddyfile` (auto-HTTPS edge,
  `/api`+`/auth`→backend, `/`→web), `docker-compose.staging.yml` (caddy 80/443 + web),
  `.env.staging.example`, `deploy-to-staging.yml` (GHCR → SSH → public HTTPS check), `ci.yml`.
- **desktop** (`MICD_APP`): `scripts/gen-build-config.sh` bakes `MICD_DEFAULT_API_ORIGIN`
  into git-ignored `src/main/build-config.generated.ts` via `prebuild`/`pretest` hooks;
  `resolveApiOrigin()` keeps the in-app override winning; unit test; `deploy-to-staging.yml`
  builds Win+Linux installers pointed at staging; `ci.yml`.

Validated locally: both compose files `docker compose config` clean, `caddy validate` passes,
all workflow YAMLs parse, desktop `tsc --noEmit` + unit tests pass in a container.

Architecture in one line: images build on **GitHub-hosted runners → GHCR**; the **VPS only
pulls** (`up -d --no-build`). Deploy = `workflow_run` after CI succeeds on `staging`, serialized
by `concurrency: deploy-staging`. Single Caddy edge terminates TLS for `dicomviewermed.online`.
Both stacks join one external `micd` network.

## What's LEFT — Phase 4 (operator; needs VPS + GitHub admin access)

1. **T4.1 — DNS.** Point `dicomviewermed.online` A record → the VPS IP. Do this **before** the
   first web deploy (Caddy needs it to issue the Let's Encrypt cert).
2. **T4.2 — VPS base.** Install Docker + Compose; run once: `docker network create micd`.
3. **T4.3 — Secrets on the VPS.** Under `$STAGING_VPS_PATH`, create `backend/.env.staging` and
   `web/.env.staging` from the committed `*.env.staging.example` files. Fill real secrets —
   e.g. `openssl rand -hex 32` for `JWT_SECRET` / `JWT_REFRESH_SECRET` (backend runs
   `NODE_ENV=production` and **fails fast** on placeholder secrets), plus DB / Orthanc / admin /
   encryption values, and `STAGING_DOMAIN` + `ACME_EMAIL` for web. Never commit these.
4. **T4.4 — GitHub secrets/variables** on each repo (see [`plan.md`](./plan.md) §5):
   - Secrets: `STAGING_VPS_HOST`, `STAGING_VPS_USER`, `STAGING_VPS_PORT`,
     `STAGING_VPS_KEYS` (private SSH key), `STAGING_VPS_PATH`.
   - Variables: `STAGING_DOMAIN`, `ACME_EMAIL`, `MICD_DEFAULT_API_ORIGIN`.
5. **T4.5 — First deploy.** Open a PR into `staging` (or run the deploy workflow via
   `workflow_dispatch`). **Backend first, then web** (edge needs backend to route `/api`).

## What's LEFT — Phase 5 (verification)

- **T5.1** Validation checklist ([`plan.md`](./plan.md) §8): HTTPS + valid cert, HTTP→HTTPS
  redirect, `/api/livez` through the edge, no host ports on internal services,
  `docker stats` within the ~1.9 GB budget.
- **T5.2** No-wasted-runs: one merge → exactly one CI + one deploy; failed CI blocks deploy;
  draft PR triggers nothing.
- **T5.3** Install a desktop staging build; confirm it targets staging and can be re-pointed.
- **T5.4** Merge the `feat/staging-deployment` branches once verified.

## First move when you resume

1. `git fetch` + `git checkout feat/staging-deployment` in all three repos.
2. Read [`spec.md`](./spec.md) → [`plan.md`](./plan.md) → [`tasks.md`](./tasks.md).
3. If you have VPS/GitHub access, start at **T4.1**. Otherwise, that access is the blocker —
   Phases 0–3 (all code) are complete and pushed.
