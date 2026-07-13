# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MICD backend — the REST API and persistence layer for a DICOM study management system (Express + TypeScript). It coordinates relational metadata in PostgreSQL, native image storage in the Orthanc PACS server, and JWT-based authentication. It acts as a secure proxy in front of Orthanc so PACS admin credentials never reach the browser client.

## Commands

```bash
make install          # npm install + create .env from .env.example + warm Python cache
make up                # docker compose up -d (postgres + orthanc + backend), seeds data
make down               # stop and remove containers
make build               # rebuild all Docker images
make restart              # build + up
make logs                  # follow logs from all services
make check                  # verify the whole stack is healthy end-to-end (scripts/check.sh)
make test                    # run integration tests (requires the stack to be up)
make generate-fake-data       # generate synthetic + volumetric DICOM test data
make seed                      # seed all staging DICOM data into the running stack
make hooks                      # install pre-commit git hooks
make pre-commit                  # run pre-commit checks manually across all files

npm run dev            # run the API locally with autoreload (Postgres/Orthanc still need Docker)
npm run build           # tsc compile to dist/
npm test                 # run all *.test.ts files (jest, no live services needed)
npx jest --testPathPatterns=<name>   # run a single test file/suite by name match
npm run test:integration  # run *.integration.test.ts files only (needs the live docker stack; sets ORTHANC_URL)
```

## Test naming convention

Two distinct kinds of test file, both under `src/`, both `*.test.ts`:

- **`*.test.ts`** (e.g. `instances-util.test.ts`, `password.service.test.ts`, `jwt.service.test.ts`, `auth-middleware.test.ts`) — pure unit tests, no live Postgres/Orthanc needed. Run by plain `npm test` and the local pre-commit hook.
- **`*.integration.test.ts`** (e.g. `studies.integration.test.ts`, `upload.integration.test.ts`, `auth.integration.test.ts`) — hit a real running backend via `axios` against `BACKEND_URL` (default `http://localhost:3000`), guarded by a `beforeAll` health check that skips the whole suite if the backend isn't reachable. Only run explicitly via `npm run test:integration` / `make test`, and by the `pre-commit` hook on `git push`.

When adding DB-backed logic, follow the existing convention: don't mock `pool` — cover it with an integration test against the real stack, the same way `studies.ts`/`upload.ts`/`auth.ts` are covered.

## Architecture

- **`src/index.ts`** — the entire Express app: all routes are registered flat here (no router modules). Two API generations coexist: a thin legacy proxy (`/api/studies*`, mirrors Orthanc's REST API almost directly) and the current one (`/api/v1/studies*`, backed by the Postgres `studies` table with pagination/filtering/search). `/api/health` and `/auth/*` are the only public routes — every other data route is gated by `requireAuth`.
- **`src/db.ts`** — owns the `pg` connection pool and `initDb()`, which idempotently creates/migrates the schema (`CREATE TABLE IF NOT EXISTS` + `ALTER ... ADD COLUMN IF NOT EXISTS`) on every startup. There is no separate migration tool — schema changes are additive statements appended to this same function.
- **`src/upload.ts`** — DICOM ingest: validates magic bytes, pushes to Orthanc, extracts DICOM tags via Orthanc's `/instances/:id/tags`, and upserts into `studies` keyed on `sop_instance_uid` (`ON CONFLICT DO UPDATE`). Duplicate uploads return 409 unless `?force=true`.
- **Auth (`src/auth.ts`, `src/auth-middleware.ts`, `src/services/{password,jwt,user,refresh-token}.service.ts`)** — JWT access (15m) + refresh (7d) tokens. Refresh tokens are rotated on every `/auth/refresh` call and stored hashed (SHA-256) in the `refresh_tokens` table; rotation is done as a single atomic `UPDATE ... RETURNING` to avoid a reuse race. Login is rate-limited per IP (`express-rate-limit`, 5 failed attempts / 15 min, `skipSuccessfulRequests`). Users are a flat credential store (`users` = `id, email, password`) with no roles/user-types. A shared test/dev user (`test@micd.local` / `testpassword`) is seeded idempotently by the schema migration in `initDb()` (`src/db.ts`) using pgcrypto's `crypt()`+`gen_salt('bf')`, so the bcrypt hash is generated in SQL — no seed credentials live in the environment. There is no self-serve user creation yet. `app.set("trust proxy", 1)` is required because the app sits behind the `web` repo's nginx — without it the rate limiter keys on nginx's IP instead of the real client.
- **Orthanc proxy pattern** — every route that touches image bytes does `axios` calls to `ORTHANC_URL` with `ORTHANC_USERNAME`/`ORTHANC_PASSWORD` basic auth (never exposed to the client); a 404 from Orthanc is translated to a 404 response, anything else to a 503.
- **Multi-repo context** — this repo is one of three siblings under the same parent checkout: `web` (browser viewer, nginx-proxies `/api/*` and `/auth/*` to this backend on the same origin) and `desktop` (Electron app; also vendors its own full copy of this backend under `desktop/backend/` for a self-contained deployment — that copy is not automatically kept in sync with this repo). Both frontends call this API directly by relative path, so any new route needs the same path on both sides of any reverse proxy.

## Docker/env specifics

- `docker-compose.yml` hardcodes `container_name: micd-postgres` / `micd-orthanc` / `micd-backend` and a fixed network name `micd` (not project-prefixed) — the `web` repo's nginx joins that same external `micd` network to reach `backend:3000` by service name. Running this stack alongside `desktop`'s bundled stack (which uses the same container names) will collide; only one can run at a time under those literal names.
- Auth secrets (`JWT_SECRET`, `JWT_REFRESH_SECRET`) must be real values in production — `NODE_ENV=production` (which `docker-compose.yml` always sets) throws at startup if they're left at their `.env.example` placeholder values.
