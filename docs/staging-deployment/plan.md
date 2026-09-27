# Staging Deployment — Technical Design

> SDD artifact 2 of 3 — **the "how".** Requirements: [`spec.md`](./spec.md). Work items:
> [`tasks.md`](./tasks.md). Every design choice here traces back to a requirement (AC-x.y) or
> constraint (Cx) in the spec.

## 1. Architecture

```
                          Internet  (HTTPS :443, HTTP :80 → redirect)
                                │
                                ▼
                    ┌───────────────────────┐   VPS (4 GB)  ── docker network: micd ──
                    │   caddy  (edge router) │
                    │   • TLS (Let's Encrypt)│
                    │   • /api/*  → backend  │
                    │   • /auth/* → backend  │
                    │   • /       → web      │
                    └───────────┬───────────┘
              ┌─────────────────┼───────────────────────────┐
              ▼                 ▼                            ▼
        ┌──────────┐     ┌──────────────┐            (only via edge; no host ports)
        │   web    │     │   backend    │────────────┬───────────────┐
        │ nginx    │     │ Express/Node │            ▼               ▼
        │ static   │     │ :3000        │      ┌──────────┐   ┌──────────────┐
        └──────────┘     └──────────────┘      │ postgres │   │   orthanc    │
         (GHCR img)        (GHCR img)          │ :5432    │   │ :8042 (PACS) │
                                                └──────────┘   └──────────────┘
```

- **web repo owns the public edge.** `caddy` + `web` (static nginx) are deployed by the `MICD_WEB`
  pipeline. Caddy is the only service that publishes host ports (80/443). (AC-2.1, AC-2.2, AC-2.4)
- **backend repo owns the data plane.** `postgres` + `orthanc` + `backend` are deployed by the
  `MICD_BACKEND` pipeline, all internal — **no host ports**. (AC-2.3)
- Both stacks attach to one **external** Docker network `micd`, created once on the VPS. Caddy
  reaches `backend:3000` and `web:80` by service name over `micd`. This reuses the existing
  contract where `web` already joins backend's `micd` network.
- Why not reuse web's nginx `/api` proxy as the router? We could, but making **Caddy** the single
  routing+TLS authority keeps the edge in one place, gives auto-HTTPS for free (no certbot cron),
  and lets the frontend image stay a pure static server. (D3)

## 2. Resource budget (C1, AC-3.1)

Tuned down from `docker-compose.prod.yml` (which allots Orthanc 2 GB) to fit 4 GB:

| Service   | Image                                    | Mem limit | Mem reserve | Rationale                         |
| --------- | ---------------------------------------- | --------- | ----------- | --------------------------------- |
| caddy     | `caddy:2-alpine`                         | 64 MB     | 32 MB       | tiny Go proxy                     |
| web       | built on `nginx:1.27-alpine`             | 48 MB     | 16 MB       | static file serving               |
| backend   | built on `node:20-alpine`                | 448 MB    | 256 MB      | Express + pg pool                 |
| postgres  | stock `postgres:16` **(digest-pinned)**  | 256 MB    | 128 MB      | small staging dataset             |
| orthanc   | `orthancteam/orthanc` (digest-pinned)    | 1024 MB   | 384 MB      | dominant consumer; tunable        |
| **Total** |                                          | **~1.9 GB** | ~0.8 GB   | leaves ~2 GB for OS/Docker/buffers |

Limits are enforced via `mem_limit`/`mem_reservation` (Compose v2 non-swarm keys) or the
`deploy.resources` block already used in prod. Values are env-overridable so the box can be tuned
without editing compose.

## 3. Per-repo changes

### 3.1 `MICD_WEB` (`web/`)

- **`Dockerfile.staging`** — multi-stage: `node:20-alpine` builds (`tsc`), then
  `nginx:1.27-alpine` serves `dist/` + static assets (mirrors the existing `Dockerfile` runtime
  stage). No API base baked (same-origin). Image → `ghcr.io/uba-micd/micd_web:staging`.
- **`Caddyfile`** (new) — the edge config:
  ```
  {$STAGING_DOMAIN} {
      encode zstd gzip
      @api path /api/* /auth/*
      handle @api { reverse_proxy backend:3000 }
      handle     { reverse_proxy web:80 }
  }
  ```
  (HTTP→HTTPS redirect and cert management are automatic in Caddy.)
- **`docker-compose.staging.yml`** (new) — services `caddy` (ports 80/443, volumes
  `caddy_data`/`caddy_config`, mounts `Caddyfile`) and `web` (image from GHCR, service/alias
  `web`, no host ports). Both on external network `micd`.
- **`.env.staging.example`** (new) — `STAGING_DOMAIN`, `ACME_EMAIL`, `WEB_IMAGE` (tag override).
- **`.github/workflows/ci.yml`** — add `staging` to `push`/`pull_request` branches; add
  `concurrency` + `cancel-in-progress`, draft guard, `paths-ignore: [docs/**]`. (AC-6.1–6.2)
- **`.github/workflows/deploy-to-staging.yml`** (new) — see §4.
- web's `nginx.conf` is unchanged (its own `/api` proxy simply never receives those paths in
  staging, since Caddy peels them off first).

### 3.2 `MICD_BACKEND` (`backend/`)

- **`Dockerfile.staging`** (new) — same multi-stage as the existing `Dockerfile` `runtime` target
  (node build → hardened runtime, tini PID 1, non-root, `HEALTHCHECK` on `/api/livez`). Image →
  `ghcr.io/uba-micd/micd_backend:staging`.
- **`docker-compose.staging.yml`** (new) — derived from `docker-compose.prod.yml` with three
  changes: (a) `backend`/`postgres`/`orthanc` pull from GHCR / digest-pinned images, no build on
  VPS; (b) **remove all host `ports:`** (internal only, AC-2.3); (c) memory limits per §2. Keeps
  `postgres:16` **digest-pinned** (C5), `TLS_ENABLED=false` (Caddy terminates TLS), network `micd`.
  Migrations run at container start (`runMigrations()` in `server.ts`) — nothing to copy.
- **`.env.staging.example`** (new) — from `.env.prod.example`: DB, Orthanc, JWT secrets, admin,
  encryption key, `TRUST_PROXY=1`, `ALLOWED_ORIGINS=` (same-origin), rate limits, tuned resource
  limits. `TLS_ENABLED=false`. No host-port vars.
- **`.github/workflows/ci.yml`** (`CI Pipeline - Backend`) — add `staging` to triggers +
  `concurrency`/guards/`paths-ignore`.
- **`.github/workflows/deploy-to-staging.yml`** (new) — §4, with a post-deploy `/api/livez` health
  check over the internal network.

### 3.3 `MICD_APP` (`desktop/`) — client build, not a server deploy (OQ-1)

- **Bake the default API origin at build time (D6, AC-5.1/5.2).** Add
  `scripts/gen-build-config.sh` that writes a generated `src/main/build-config.generated.ts`:
  ```ts
  export const BUILD_DEFAULT_API_ORIGIN = "http://localhost:3000"; // ← replaced from env at build
  ```
  from `${MICD_DEFAULT_API_ORIGIN:-http://localhost:3000}`, run before `tsc` in the `build` script.
  `src/main/shared-config.ts`'s `DEFAULT_API_ORIGIN` becomes
  `BUILD_DEFAULT_API_ORIGIN` (fallback preserved). The in-app `electron-store` override is
  untouched, so it still wins at runtime (AC-5.2). The generated file is git-ignored.
- **`.env.staging.example`** (new) — documents `MICD_DEFAULT_API_ORIGIN=https://<staging-domain>`.
- **`.github/workflows/deploy-to-staging.yml`** (new) — reuses the existing multi-OS build from
  `build-desktop.yml` (**Windows + Linux**), triggered by CI completion on `staging`, with
  `MICD_DEFAULT_API_ORIGIN=https://dicomviewermed.online` set from a repo variable; uploads the
  installers as artifacts. No VPS involvement.
- **No `Dockerfile.staging` / `docker-compose.staging.yml`** for desktop — there is nothing to host
  server-side (confirmed).

## 4. CI/CD design (D4, D5, US-1, US-6)

**Two jobs per deployable repo**, GitHub-hosted:

```yaml
# deploy-to-staging.yml  (web & backend)
on:
  workflow_run:
    workflows: ["<that repo's CI workflow name>"]   # "CI" / "CI Pipeline - Backend"
    types: [completed]
    branches: [staging]
  workflow_dispatch:
concurrency: { group: deploy-staging, cancel-in-progress: true }   # AC-6.3

jobs:
  build-push:                     # runs on ubuntu-latest (D5)
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'  # AC-1.2
    # docker/login-action → ghcr.io (GITHUB_TOKEN, packages: write)
    # docker/build-push-action: file Dockerfile.staging, cache-from/to gha,
    #   tags :staging + :sha-<short>
  deploy:                         # runs on ubuntu-latest, SSHes to the VPS
    needs: build-push
    environment: staging
    # appleboy/scp-action: copy docker-compose.staging.yml (+ Caddyfile for web)
    # appleboy/ssh-action:
    #   docker network create micd || true
    #   docker login ghcr.io ; docker compose -f … --env-file .env.staging pull ; up -d --no-build
    #   health check loop (curl /api/livez for backend; https cert/200 for web)
```

**Why this satisfies "no unnecessary executions" (US-6):**
- Deploy has a **single** trigger — CI completion on `staging` — so a merge produces exactly one
  CI run then one deploy, never a push-and-PR double fire. (AC-6.3)
- `concurrency: deploy-staging` serializes/cancels stacked deploys. (AC-6.3)
- CI gains `concurrency` + `cancel-in-progress`, a **draft-PR guard**
  (`if: github.event.pull_request.draft == false || github.event_name == 'push'`) and
  `paths-ignore: [docs/**]`. (AC-6.1, AC-6.2)
- The 4 GB box never builds: images build on GitHub runners, the VPS only `pull`s. (AC-3.2)

## 5. Secrets & variables (AC-4.2)

Per deployable repo (`MICD_WEB`, `MICD_BACKEND`; desktop needs only the variable):

| Kind             | Name                  | Used by        | Notes                                            |
| ---------------- | --------------------- | -------------- | ------------------------------------------------ |
| secret           | `STAGING_VPS_HOST`    | deploy         | VPS IP / hostname                                |
| secret           | `STAGING_VPS_USER`    | deploy         | SSH user                                         |
| secret           | `STAGING_VPS_PORT`    | deploy         | SSH port                                         |
| secret           | `STAGING_VPS_KEYS`    | deploy         | SSH private key                                  |
| secret           | `STAGING_VPS_PATH`    | deploy         | dir on VPS holding compose + `.env.staging`      |
| variable         | `STAGING_DOMAIN`      | web deploy     | `dicomviewermed.online` (ACME)                   |
| variable         | `ACME_EMAIL`          | web deploy     | Let's Encrypt notifications                      |
| variable         | `MICD_DEFAULT_API_ORIGIN` | desktop    | `https://dicomviewermed.online`                  |
| (auto)           | `GITHUB_TOKEN`        | build-push     | GHCR auth; `permissions: packages: write`        |

**Not** in GitHub: the backend's real `.env.staging` (DB/JWT/Orthanc/admin secrets) lives **only on
the VPS** at `STAGING_VPS_PATH`, created once from `.env.staging.example` (C6).

## 6. VPS one-time setup (prerequisites)

1. Point the staging domain's `A` record at the VPS IP (before first web deploy, for ACME — risk in
   spec §6).
2. Install Docker Engine + Compose plugin.
3. `docker network create micd`.
4. Create `STAGING_VPS_PATH/backend/.env.staging` and `STAGING_VPS_PATH/web/.env.staging` from the
   committed examples; fill in secrets (`openssl rand -hex 32` for JWT, etc.).
5. Ensure the SSH user can run Docker (in the `docker` group) and that inbound 80/443/22 are open.

## 7. Rollout & rollback

- **Rollout order:** backend stack first (creates `micd`, brings up data plane), then web/edge.
  Either order works (both create the network; web returns 502 on `/api` only until backend is up).
- **Image tags:** every build also pushes `:sha-<short>`. Rollback = redeploy a prior SHA tag
  (`WEB_IMAGE=…:sha-abc123 docker compose … up -d --no-build`) or re-run an older deploy via
  `workflow_dispatch`.
- **Data:** `postgres-data` / `orthanc-data` are named volumes and survive redeploys.

## 8. Validation (maps to acceptance criteria)

- `https://<domain>/` serves the SPA with a valid cert (AC-2.1); `curl -I http://<domain>` → 308/301
  to HTTPS (AC-2.4).
- `https://<domain>/api/livez` → 200 through the edge (AC-2.2); `docker ps` shows no host ports on
  backend/postgres/orthanc (AC-2.3).
- `docker stats` sum within budget (AC-3.1).
- Merge a trivial PR to `staging` → one CI run → one deploy; a failing CI blocks deploy (AC-1.1/1.2);
  a draft PR triggers nothing (AC-6.2).
- A desktop installer from the staging pipeline opens already pointed at `https://<domain>` and can
  be re-pointed in-app (AC-5.1/5.2).
