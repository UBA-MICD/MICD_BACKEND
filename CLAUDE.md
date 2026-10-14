# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MICD backend — the REST API and persistence layer for a DICOM study management system (Express + TypeScript). It coordinates relational metadata in PostgreSQL, native image storage in the Orthanc PACS server, and JWT-based authentication. It acts as a secure proxy in front of Orthanc so PACS admin credentials never reach the browser client.

## Commands

> Prefer Docker over host `npm`: run builds/typechecks/tests inside a container
> (e.g. `docker run --rm -v "$PWD":/app -w /app node:20-alpine sh -c "npm ci && npx tsc --noEmit"`)
> or via the compose stacks, rather than invoking `npm` directly on the host.

```bash
make install          # npm install + create .env from .env.example + warm Python cache
make up                # docker compose up -d (postgres + orthanc + backend), seeds data
make down               # stop and remove containers
make build               # rebuild all Docker images
make restart              # build + up
make logs                  # follow logs from all services
make check                  # verify the whole stack is healthy end-to-end (scripts/check.sh)
make test                    # run integration tests against an already-running stack
make test-integration-docker  # spin up a throwaway stack and run the integration suites end-to-end (self-contained)
make generate-fake-data       # generate synthetic + volumetric DICOM test data
make seed                      # seed all staging DICOM data into the running stack
make hooks                      # install pre-commit git hooks
make pre-commit                  # run pre-commit checks manually across all files

npm run dev            # run the API locally with autoreload (Postgres/Orthanc still need Docker); entry = src/server.ts
npm run build           # tsc compile src/ to dist/ (tests are NOT compiled into the build)
npm test                 # run all *.test.ts (jest) — unit + integration; integration self-skips if no live backend
npm run test:unit         # unit suites only (tests/unit/**, no live services needed)
npm run test:integration  # integration suites only (tests/integration/**; needs the live stack; sets ORTHANC_URL)
npx jest --testPathPatterns=<name>   # run a single test file/suite by name match
```

## Project structure (layered, feature-first)

Production code lives in `src/`; every request flows
**routes → controller (HTTP only) → service (business logic, throws `HttpError`) → repository (SQL) / client (Orthanc)**.
Controllers never touch `pool` or `axios` directly.

```
src/
  config/env.ts              # all process.env reads + prod JWT-secret check, in one place
  shared/
    http-error.ts            # HttpError class + sendError(res, err) — services own status codes
    instances-util.ts        # pure instance-ordering helpers (no I/O)
  clients/orthanc.client.ts  # the ONLY authenticated wrapper over Orthanc's REST API
  db/
    pool.ts                  # the pg Pool
    migrate.ts               # runMigrations(): applies migrations/*.ts in order, idempotently
    migrations/001_studies.ts, 002_auth.ts
  middleware/                # auth.middleware (requireAuth), rate-limit.middleware, upload.middleware (multer)
  modules/
    health/                  # routes + controller (DB + Orthanc probe)
    auth/                    # routes/controller/auth.service + password/jwt/user/refresh-token services
    studies/                 # routes/controller/service/repository (legacy proxy + v1 Postgres-backed)
    upload/                  # routes/controller/service/repository (DICOM ingest)
  app.ts                     # assembles Express from the module routers + Swagger UI; no listener (importable by tests)
  server.ts                  # bootstrap: runMigrations() then app.listen — the process entry point (dist/server.js)
  openapi.ts                 # OpenAPI 3.0 spec object served at /api/docs and /api/docs/openapi.json
tests/
  unit/                      # pure logic, no live services (instances-util, auth-middleware, auth/{jwt,password})
  integration/               # axios vs a live backend/Orthanc (auth, studies, upload, orthanc)
  helpers/auth.ts            # getAuthHeader() — logs in test@micd.local and caches the Bearer header
```

Two API generations coexist and keep their exact URLs: a thin legacy proxy (`/api/studies*`, mirrors Orthanc) and the current one (`/api/v1/studies*`, Postgres-backed with pagination/filtering/search). `/api/health`, `/auth/*` and `/api/docs*` are the only public routes — every other data route is gated by `requireAuth`. The legacy `POST /api/instances` is an alias of `POST /api/v1/studies/upload` (same handler).

## Test convention

- **`tests/unit/**/*.test.ts`** — pure unit tests, no live Postgres/Orthanc. Run by `npm run test:unit` and the local pre-commit hook.
- **`tests/integration/**/*.integration.test.ts`** — hit a real running backend via `axios` against `BACKEND_URL` (default `http://localhost:3000`) / `ORTHANC_URL`, guarded by a `beforeAll` health check that skips the whole suite if the target isn't reachable. Run via `npm run test:integration` / `make test` (against a stack you brought up) or, fully self-contained, `make test-integration-docker`.
- jest roots at `tests/` and transforms via `tsconfig.jest.json` (widened `rootDir` so tests can import `src/`); the production `tsconfig.json`/`npm run build` stays `src`-only, so tests never land in `dist/`.
- When adding DB-backed logic, don't mock `pool` — cover it with an integration test against the real stack, the same way `studies`/`upload`/`auth` are.

## Architecture notes

- **Migrations** (`src/db/migrate.ts` + `db/migrations/*.ts`) replace the old monolithic `initDb()`. There is still no separate migration tool: each migration is idempotent (`CREATE/ALTER ... IF [NOT] EXISTS`) and all of them run on every startup (via `runMigrations()` in `server.ts`). Add schema changes as a new numbered file appended to the `migrations` array.
- **Auth** (`modules/auth/*`, `middleware/{auth,rate-limit}.middleware.ts`) — JWT access (15m) + refresh (7d) tokens. Refresh tokens are rotated on every `/auth/refresh` and stored hashed (SHA-256) in `refresh_tokens`; rotation is a single atomic `UPDATE ... RETURNING` to avoid a reuse race (`consumeRefreshToken`). Login is rate-limited **per IP** (`express-rate-limit`, 5 failed attempts / 15 min, `skipSuccessfulRequests`). Users are a flat credential store (`users` = `id, email, password`) with **no roles/user-types**. A shared test/dev user (`test@micd.local` / `testpassword`) is seeded **in SQL** by migration 002 using pgcrypto's `crypt()`+`gen_salt('bf')`, so the bcrypt hash is generated in-database — no seed credentials in the environment, and there is no application-side `seedAdminUser`. Self-service password recovery (`/auth/forgot-password`, `/auth/reset-password`, table `password_resets`) mirrors the invite-code scheme — see `docs/password-recovery.md`. `app.set("trust proxy", 1)` (in `app.ts`) is required because the app sits behind the `web` repo's nginx — without it the rate limiter keys on nginx's IP.
- **Orthanc proxy pattern** — all Orthanc access goes through `clients/orthanc.client.ts` (basic-auth credentials live only there). Services map Orthanc status codes to domain errors: a 404 becomes a 404 response, 415/400 on a thumbnail becomes 422, anything else becomes 503.
- **Upload** (`modules/upload/*`) — validates DICOM magic bytes, pushes to Orthanc, extracts tags via `/instances/:id/tags`, and upserts into `studies` keyed on `sop_instance_uid` (`ON CONFLICT DO UPDATE`). Duplicate uploads return 409 unless `?force=true`.
- **Multi-repo context** — this repo is one sibling under a shared parent checkout alongside `web` (browser viewer; nginx-proxies `/api/*` and `/auth/*` to this backend on the same origin) and `desktop` (Electron app that also vendors its own copy of this backend under `desktop/backend/`, not auto-synced). Both frontends call this API by relative path, so a new route needs the same path on both sides of any reverse proxy.

## Docker/env specifics

- `docker-compose.yml` hardcodes `container_name: micd-postgres` / `micd-orthanc` / `micd-backend` and a fixed network name `micd` (not project-prefixed) — the `web` repo's nginx joins that same external `micd` network to reach `backend:3000` by service name. Running alongside `desktop`'s bundled stack (same container names) will collide; only one can run at a time under those literal names.
- Auth secrets (`JWT_SECRET`, `JWT_REFRESH_SECRET`) must be real values in production — `NODE_ENV=production` (always set by `docker-compose.yml`) throws at startup if they're left at their `.env.example` placeholders. The check lives in `config/env.ts`.
- **⚠️ Contaminated `postgres:16-alpine` tag.** In this monorepo the local `postgres:16-alpine` (and `16-bookworm`) image tag is **overridden by the marketplace UserService image**, which bakes Auth0-based migrations into `/docker-entrypoint-initdb.d/` that create a `users` table (`auth0_id` PK, `full_name`, no password) colliding with this backend's own auth `users` table. A fresh cluster built from that image runs those init scripts first, so the MICD auth migration then fails (`column "password" does not exist`). `docker-compose.test.yml` avoids this by pinning Postgres to a **digest of the stock image**; if `docker-compose.yml`/`make up` ever fails at startup with that error, this tag collision is why.
- **Dockerized integration tests** (`docker-compose.test.yml`, `Dockerfile` `test` stage, `make test-integration-docker`) — a throwaway Postgres + Orthanc + backend stack on an isolated network (`micd-test`, distinct container names, tmpfs storage, no host ports), with a `tests` service that runs the Jest integration suites from inside the network against the live services, then tears everything down (exit code mirrors the run). The runner uses jest's **default parallel** mode on purpose: every suite's `beforeAll` grabs its auth token up-front, before the auth suite's rate-limit test trips the shared per-IP login limiter — `--runInBand` would serialize the suites and poison later logins with 401s. Known minor flake: the studies "search by patient name" test is data-dependent on the sample DICOM's patient name and can occasionally fail.
