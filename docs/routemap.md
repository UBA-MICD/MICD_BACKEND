# Routemap — US-21 (RBAC) + US-H04 (user management)

Ordered, per-step execution guide for the plan in
[`us-21-rbac-plan.md`](./us-21-rbac-plan.md). That file is the *design* (why + what);
this file is the *sequence* (do this, then this, verify, commit). A future session
should be able to execute the whole feature from this document plus the plan.

## Progress (2026-08-20)

- ✅ **Step 0 — docs** committed (`cb3a5b8`): routemap + plan + memory.
- ✅ **PR1 — Roles & enforcement** complete (`942f8da`…`2dd115f`), one commit per
  step 1.1–1.7. 327 unit + 58 integration tests green (`make test-integration-docker`).
  Notes from execution:
  - **1.1 landmine had a THIRD line:** `002_auth.ts` also dropped `last_login_at`
    (original `:60`), same wipe-on-boot failure — fixed alongside role/status.
  - `HttpError`'s real signature is `(status, body)`, not the plan's 3-arg sketch;
    403 body is `{ error: "Forbidden", detail: "Requires role: …" }`.
  - The dockerized integration stack could not boot at all (pre-existing: `env.ts`
    fail-fast vs the compose's literal `micd`/`orthanc` creds under
    `NODE_ENV=production`). Fixed in `35763ef` with non-default test secrets.
  - Migration 006 seeds admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (bound param,
    not interpolated); the runner now accepts `{ text, values }` statements.
  - PR1 integration mints role tokens via a shared JWT secret (`getAuthHeaderFor`);
    once PR2's user API lands, these can switch to real seeded accounts.
- ✅ **PR2 — User management panel (US-H04 core)** complete. Backend: three atomic
  commits (`8708608` audit actions, `aece078` users module, `c6eb727` login
  stamp/refuse). Frontend: web `feat/us-21-rbac` `e9c3a55` (admin panel), vendored
  to desktop `feat/us-21-rbac` `5990b11` (parity clean). 348 unit + 67 integration
  (backend) and 162 (web) tests green. Notes:
  - **Branches:** web + desktop had no `feat/us-21-rbac`; created it in each from
    their current checkout (web was on `fix/desktop-seam-save-result`, desktop on
    `dev`). The desktop sync also caught the renderer up to web HEAD (a small
    pre-existing export-service delta rode along — parity is all-or-nothing).
  - The invite issuance + `POST /:id/invite` are deferred to PR3 (they need the
    `user_invites` table + mailer). PR2 `POST /users` creates an `invited`,
    password-less user; PR3 wires the code + email.
  - Migration runner extended in PR1 already covers the parameterized admin seed.
- ⏭️ **NEXT: PR3 Step 3.1** — migration `007_user_invites` + invite flow.

## Ground rules (apply to every step)

- **Branch:** one branch `feat/us-21-rbac` across the work. **One commit per step**
  below. Conventional Commits on backend (`feat(auth): …`), plain imperative on
  web/desktop.
- **No self-attribution** in commits or PRs — no `Co-Authored-By`, no Claude trailer.
- **No host `npm`.** Build/typecheck/test inside containers (see Verify blocks).
- **Never hand-edit `desktop/src/renderer/`.** It is an `rsync` of `web/src`. Change
  `web/src`, then in `desktop/`: `make sync-web` → `make parity` (empty diff) →
  commit `src/renderer` + `.web-sync`.
- **Migrations are idempotent and all run on every startup** (no tracking table).
  Every DDL is `CREATE/ALTER ... IF [NOT] EXISTS`. Append new files to the array in
  `src/db/migrate.ts`.
- **Coverage gate is real:** `backend/.codecov.yml` = 80% project + 80% patch,
  `if_ci_failed: error`. New backend code without a *unit* test drops the gate,
  because CI never starts the server so integration suites self-skip there.
- **Do NOT add `collectCoverageFrom` to `jest.config.js`** — it would instantly count
  `server.ts` + unimported route files as 0% and fail the gate.

---

## PR 1 — Roles & enforcement

Goal: every one of the 32 authenticated endpoints enforces a role; deploy self-heals
old tokens; the pre-existing HTML-500 bug is fixed.

### Step 1.1 — Defuse the migration landmine *(own commit — highest risk)*
- Edit `src/db/migrations/002_auth.ts`: delete `:47`
  (`DROP COLUMN IF EXISTS role`) **and** `:49` (`DROP COLUMN IF EXISTS status`).
  Update the file header comment that advertises those drops as intentional.
- **Verify:** boot the stack twice, confirm nothing wipes new columns (regression
  test is Step 1.3's restart check).

### Step 1.2 — `src/shared/roles.ts` *(new)*
- `export const ROLES = ["admin","medico","investigador"] as const;`
- `export type Role = (typeof ROLES)[number];`
- `export function isRole(x: unknown): x is Role` — the single source of truth reused
  by the migration constant, middleware, OpenAPI, and tests.

### Step 1.3 — Migration `006_roles.ts` *(new)*
- Normalize-then-constrain `role` and `status` (values in plan). Add `name TEXT`,
  `last_login_at TIMESTAMPTZ`. `ALTER COLUMN password DROP NOT NULL`.
- Seed the first admin (reuse 002's pgcrypto `crypt()`/`gen_salt('bf',12)` pattern),
  reading `ADMIN_EMAIL`/`ADMIN_PASSWORD` — but the seed SQL must degrade gracefully in
  CI. Set `test@micd.local` → `role='medico'` (**never admin**).
- Append `"006_roles"` to `migrate.ts`.
- **Verify (the landmine regression test):**
  ```bash
  make restart
  docker exec micd-postgres psql -U postgres -d micd \
    -c "UPDATE users SET role='admin' WHERE email='...'; "
  make restart
  docker exec micd-postgres psql -U postgres -d micd \
    -c "SELECT email, name, role, status, last_login_at FROM users;"   # role survived
  ```

### Step 1.4 — Role into the JWT (BOTH sign sites)
- `src/modules/auth/jwt.service.ts:5-8` — add `role: Role` to `AccessTokenPayload`.
  It reaches `req.user` for free via the `namespace Express` block in
  `auth.middleware.ts`.
- `src/modules/auth/auth.service.ts` — the token is signed in **two** places
  (login `~:52` and refresh `~:85`). Both must include `role`, or a refreshed session
  silently loses it.
- `src/modules/auth/user.service.ts` — `findUserByEmail` / `findUserById` SELECTs add
  `role, status`. Treat NULL password as "cannot log in" (never pass NULL to
  `bcrypt.compare`).

### Step 1.5 — `requireRole` + global handlers
- `src/middleware/auth.middleware.ts` — add `requireRole(...roles)` per the plan:
  missing/invalid claim → **401** (lets `authFetch` refresh+retry); wrong role →
  `next(new HttpError(403, "Forbidden", ...))`; expose `guard.roles` for the
  route-matrix test.
- `src/app.ts` — add a **404 handler** and a **global error handler** mapping
  `HttpError` → `{ error, detail? }`, else JSON 500. This also fixes the live
  HTML-500 from `activity.controller.ts:31,61`.

### Step 1.6 — Gate all 32 endpoints
- Apply `requireRole(...)` per the matrix in the plan across `studies.routes.ts`,
  `upload.routes.ts`, `activity.routes.ts`, and **split the blanket
  `zenodoRouter.use(requireAuth)`** into per-route `requireAuth, requireRole(...)`.
- Retract the "no roles" comment in `zenodo.routes.ts:7-9`.

### Step 1.7 — Tests + docs
- `tests/unit/require-role.test.ts` — role × allowed/denied, missing `req.user`,
  unknown role. Mirror `tests/unit/auth-middleware.test.ts` (no supertest).
- Route-matrix unit test walking `router.stack` (idiom in
  `tests/unit/health/health.routes.test.ts:9-12`).
- `tests/integration/rbac.integration.test.ts` — table-driven over the matrix;
  extend `tests/helpers/auth.ts` with `getAuthHeaderFor(role)`.
- `backend/docs/rbac.md` (skeleton; finalized in PR5). Update `openapi.ts`
  (`role` on `AuthUser`/`LoginResponse`, shared 403).
- **Verify:**
  ```bash
  cd backend && docker run --rm -v "$PWD":/app -w /app node:20-alpine \
    sh -c "npm ci && npx tsc --noEmit && npm run test:unit"
  make test-integration-docker
  ```

---

## PR 2 — User management panel (US-H04 core)

### Step 2.1 — `src/modules/users/` (routes→controller→service→repository)
- Endpoints (all `requireAuth, requireRole("admin")`): `GET /api/v1/users`,
  `POST` (name+email+role, status `invited`), `PATCH :id/role`, `PATCH :id/status`,
  `DELETE :id` (**soft-delete**: status `deleted` + revoke refresh tokens),
  `POST :id/invite`.
- `GET` excludes `status='deleted'`, returns `last_login_at` + `name`.
- **Self/last-admin guards** in the service, `HttpError(409)`: no self block/delete/
  demote; protect the last admin under `SELECT ... FOR UPDATE` in a transaction.

### Step 2.2 — Login stamps last-access + refuses blocked/deleted
- In the login path (`auth.service.ts`), after `bcrypt.compare` passes:
  `UPDATE users SET last_login_at = NOW() WHERE id = $1`.
- Refuse `status IN ('blocked','deleted')` with the **same generic 401** as bad
  credentials (no account-state disclosure).

### Step 2.3 — Audit actions
- `src/shared/audit.ts` — add `USER_CREATED`, `USER_ROLE_CHANGED`, `USER_BLOCKED`,
  `USER_UNBLOCKED`, `USER_DELETED`, `INVITE_SENT`, `INVITE_REDEEMED`.

### Step 2.4 — Frontend admin panel (`web/src`)
- New `tab-usuarios` / `panel-usuarios` (admin-only) in `index.html`; wire
  `server-screen.ts` (`ServerTab` type, `TABS`, id→tab lookup replacing the binary
  ternary, hide-for-non-admin in `renderForSession`).
- `auth.ts` — add `role` to `AuthUser`, read in `decodeToken`, export
  `getCurrentRole()`. Add a **403 branch** to `authFetch` (must NOT trigger the
  401 refresh/login escalation).
- New `web/src/admin/` folder — list (name/email/role/status/last-access), create
  form (name+email+role), block/enable, soft-delete. Pure logic DOM-free for
  `node:test`.
- **Web gates:** i18n keys in **both** `locales/en.ts` + `locales/es.ts`,
  `escapeHtml`/`escapeAttr` on interpolation, `onLocaleChange` re-render, roving
  tabindex, **no new runtime dependency**.
- **Verify + vendor:**
  ```bash
  cd web && docker run --rm -v "$PWD":/app -w /app node:22-alpine \
    sh -c "npm ci && npm run build && npm test"
  # commit web, then:
  cd ../desktop && make sync-web && make parity   # must print nothing
  # commit desktop src/renderer + .web-sync
  ```

---

## PR 3 — Invite flow (US-H04 create-user)

### Step 3.1 — Migration `007_user_invites.ts`
- `user_invites` table (plan). Code stored **SHA-256 hashed**; consumption is a single
  atomic `UPDATE ... RETURNING` (reuse `refresh-token.service.ts`'s pattern).

### Step 3.2 — Public auth routes (rate-limited)
- `GET /auth/invite/:code` → `{ email }` or 404. `POST /auth/accept-invite`
  `{ code, password }` → set password (reuse `password.service.ts` rules), consume,
  return `{ accessToken, refreshToken, user }`. Add a **separate `inviteRateLimiter`**
  (don't share the login limiter).

### Step 3.3 — Mailer
- `src/shared/mailer.ts` with `nodemailer` (the one new backend dep). Config via
  `SMTP_*` + `APP_BASE_URL` through `config/env.ts` only. `SMTP_HOST` unset →
  `sendInvite()` logs the link to stdout (dev/CI/integration work with no mail
  server). Templates in `es` + `en`.
- Fix `backend/.env.example` (dup `ORTHANC_PASSWORD=`, stray `admin` line) and add
  `SMTP_*`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `APP_BASE_URL` — CI does
  `cp .env.example .env`.

### Step 3.4 — Accept-invite frontend
- Public screen in the `src/shared/screen.ts` registry, entered from `?invite=<code>`.
  On load, `history.replaceState` to **strip the code from the URL** (it leaks via
  history + `Referer`). Vendor to desktop as in Step 2.4.

---

## PR 4 — Investigador PHI redaction

### Step 4.1 — Metadata: `src/modules/studies/study-redaction.ts` *(new, pure)*
- `redactStudy(row, role)` in the studies **service** over `findStudies` +
  `findStudyZenodoMeta`. investigador: `patient_name`→`"ANONYMIZED"`,
  `patient_id`→`sha256` prefix. Unit-test per role.
- **Close the PHI oracle:** also neutralize the `patient_name ILIKE` search filter
  (`studies.repository.ts:18-22`) for investigador, else they binary-search real
  names.

### Step 4.2 — DICOM headers: `src/shared/phi-tags.ts` *(new)*
- Backend port of the 20-tag `PII_TAGS` list from `web/src/utils/dicom-anonymizer.ts`.
  Filter `getInstanceTags` output for investigador.

### Step 4.3 — File downloads: Orthanc anonymize
- Add `anonymizeInstance` to `orthanc.client.ts`. **Verify against the running Orthanc
  (24.1.2)** that anonymize returns the DICOM **in the response body** and does not
  persist a new resource, and that UIDs are preserved for the viewer — pass
  `Keep: [StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID, ...]` + `Force: true`
  if not. Route `getStudyFile`/`getInstanceFile` through it when
  `role === "investigador"`.
- Thumbnails/previews unchanged. Note the **burned-in pixel PHI** limitation in
  `rbac.md`.

---

## PR 5 — Final documentation (last, after code lands)

- Finalize `backend/docs/rbac.md` (roles, 32-route matrix, 401/403 shapes, 15-min
  stale-token caveat, PHI boundary + burned-in-pixel limitation).
- New `backend/docs/user-management.md` (US-H04 lifecycle: create/invite/accept,
  block/enable/soft-delete, last-access, self/last-admin guards).
- Retract `backend/docs/zenodo.md:3` "no roles". Land any remaining OpenAPI `role`
  additions. Document new env vars in README/staging notes.

---

## Known traps (surfaced during exploration — don't rediscover them)

- `docker-compose.test.yml` sets `NODE_ENV: production` → **don't gate dev behavior on
  `NODE_ENV`**; use explicit flags (`SEED_TEST_USERS`, `smtpConfig.enabled`).
- `postgres:16-alpine` tag is contaminated by a marketplace UserService image; the
  test compose pins a digest. If `make up` fails with `column "password" does not
  exist`, that's why.
- `desktop/backend/` vendors its own backend copy, **not auto-synced** — will diverge
  silently if that stack is used.
- Prod sits behind a plain-HTTP UBA proxy; `npm ci` silently no-ops without `http://`.
