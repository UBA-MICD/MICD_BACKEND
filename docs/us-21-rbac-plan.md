# US-21 / US-H04 — RBAC + admin-driven user management

> **What this is.** The design document for two linked backlog tickets — **US-21**
> (RBAC: `admin` / `medico` / `investigador`) and **US-H04** (admin user lifecycle:
> create / invite / suspend / delete + last-access). It is the source of truth for
> the four code PRs and the final-docs PR. The step-by-step execution guide lives
> next to it in [`routemap.md`](./routemap.md).

## Context

MICD has authentication but **no authorization**. `users` is a flat credential store
— `(id, email, password)` — and all **32 authenticated** endpoints (of 38 total; the
other 6 are public `/auth` + health routes) sit behind the same `requireAuth`. Two
places in the repo say so out loud and must be retracted:
`backend/src/modules/zenodo/zenodo.routes.ts:7-9` and `backend/docs/zenodo.md:3`
("this backend has a flat user model (no roles)").

There is also **no way to create a user**. The only account is `test@micd.local`,
seeded in SQL by migration 002. So the create-user flow is a prerequisite for US-21,
not a side-quest.

This plan covers **two backlog tickets** in one feature family (US-H04 depends on
US-21): **US-21** (Sprint 3, 5 SP — roles + 403 enforcement + role panel) and
**US-H04** (Sprint 4, 3 SP — admin user lifecycle: create with name/email/role, email
invite + password creation, suspend **or delete** accounts, own non-shared
credentials, **last-access visible to admin**). US-21's PR1 does roles/enforcement;
PR2+PR3 satisfy US-H04's create/manage/invite; the name, soft-delete, and
`last_login_at` additions are the US-H04-specific deltas over US-21's panel.

US-21 (depends on TK-05 → shipped as `feat/tk-05-jwt-auth`) asks for three roles,
per-endpoint 403 enforcement, an admin panel to assign/revoke roles, authorization
tests, and `/docs/rbac.md`. Two user clarifications widen it:

1. Admin manages users from a panel that can **create / block / enable**. A created
   user gets an **email with a code** and sets their own password from it.
2. **`investigador` never sees PHI** — patient identity is stripped from metadata,
   from DICOM headers, and from downloaded files. They see the pictures, not the
   people.

Outcome: every endpoint enforces a role, an admin can run the user lifecycle from
the UI, and a researcher account is safe to hand out because it is structurally
incapable of reading patient identity.

---

## Decisions (locked)

| Question | Decision |
|---|---|
| Role model | Single `role` column on `users`, NOT NULL, CHECK-constrained to the 3 values. One JWT claim. |
| Account state | Single `status TEXT` column — `active` / `invited` / `blocked` / `deleted`. Needs the extra states anyway (invited user has no password; deleted is soft), so `status` beats a `is_blocked BOOLEAN`. |
| User name | `name TEXT` column on `users` (US-H04 wants nombre + email + rol at create). |
| Last access | `last_login_at TIMESTAMPTZ` column, stamped on successful login, shown in the admin list (US-H04 "registro de último acceso visible para el admin"). |
| Delete | **Soft-delete** (`status='deleted'`), never hard `DELETE`. `audit_log.user_id` + `zenodo_config.created_by` FK `users(id)` with no `ON DELETE` clause, so a hard delete either fails or would orphan the audit trail. Soft-delete satisfies US-H04 "eliminar cuentas" while preserving audit. |
| User creation | Admin-only. No public self-registration. Admin sets email + role; the *user* sets their own password. |
| First admin | Seeded in a migration, reusing 002's pgcrypto `crypt()`/`gen_salt('bf')` pattern. |
| Anonymization | Orthanc's built-in anonymize API via a new `orthanc.client.ts` method + a metadata redaction pass. |
| Email | `nodemailer` + `SMTP_*` env vars; console-log fallback when SMTP is unset (dev/CI still usable). |
| Blocking | Revoke all refresh tokens + refuse login. Accept ≤15 min of residual access-token validity rather than adding a DB round-trip to `requireAuth`. |
| Delivery | Five sequenced, independently-reviewable PRs (4 code + 1 final-docs). |

---

## ⚠️ The landmine — read before writing any migration

`backend/src/db/migrations/002_auth.ts:47` **and `:49`**:

```sql
ALTER TABLE users DROP COLUMN IF EXISTS role;    -- :47
ALTER TABLE users DROP COLUMN IF EXISTS status;  -- :49
```

There is **no migration tracking table**. `src/db/migrate.ts` runs *every* migration
on *every* startup, relying on idempotent DDL. A `role` (or `status`) column added in
a new migration is therefore dropped by 002 and re-added empty by 006 **on every
single boot**, silently wiping all assigned roles and states. This is the
highest-risk edit in the story and gets its own commit.

**Fix:** delete **both** line 47 and line 49, and update the file's header comment
(which currently advertises dropping `role`/`status` as intentional). To stay safe
against a legacy DB that has these columns with foreign values, migration 006
normalizes before constraining:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
UPDATE users SET role = 'medico'
  WHERE role IS NULL OR role NOT IN ('admin','medico','investigador');
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'medico';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','medico','investigador'));
```

Same normalize-then-constrain for `status`:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT;
UPDATE users SET status = 'active'
  WHERE status IS NULL OR status NOT IN ('active','invited','blocked','deleted');
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE users ALTER COLUMN status SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active','invited','blocked','deleted'));
```

Plus the two US-H04 columns (both idempotent, both nullable):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
```

`last_login_at` is stamped on every successful login — `auth.service.ts` login path
does `UPDATE users SET last_login_at = NOW() WHERE id = $1` after `bcrypt.compare`
passes.

Also in 006: `ALTER TABLE users ALTER COLUMN password DROP NOT NULL;` — an
admin-created user has no password until they redeem their invite (`status='invited'`).
`findUserByEmail` must then treat a NULL password as "cannot log in" (never pass NULL
to `bcrypt.compare`).

**The `test@micd.local` seed (002:63-65) becomes a role/status question.** It is
seeded unconditionally, **including production**. 006 must set its `role='medico'`,
never `admin` — else it is a production admin backdoor with a known password.

---

## Part 1 — Roles & enforcement (PR 1)

### Backend changes

| File | Change |
|---|---|
| `src/db/migrations/002_auth.ts` | delete `:47`, fix header comment |
| `src/db/migrations/006_roles.ts` *(new)* | `role` + `status` + `name` + `last_login_at` + password-nullable + admin seed + `test@micd.local`→`medico`; append to `migrate.ts`'s array |
| `src/modules/auth/jwt.service.ts:5-8` | add `role: Role` to `AccessTokenPayload` — propagates to `req.user` for free via the `namespace Express` declaration in `auth.middleware.ts:7-14` |
| `src/modules/auth/auth.service.ts:52` **and** `:85` | the token is signed in **two** places (login *and* refresh). Both need the role or a refreshed session silently loses it. |
| `src/modules/auth/user.service.ts` | `findUserByEmail` / `findUserById` both `SELECT id, email, password` → add `role, is_blocked` |
| `src/middleware/auth.middleware.ts` | add `requireRole` |
| `src/app.ts` | add a **global error handler + 404 handler** (see below) |
| `src/shared/roles.ts` *(new)* | `ROLES` tuple + `Role` type + `isRole()` — one source of truth shared by middleware, migration constant, and OpenAPI |

`requireRole` returns a middleware whose allowed `roles` are readable off the returned
function (`fn.roles = roles`), so a **route-matrix test** can walk `router.stack` and
assert each route's guard — the idiom already used in
`tests/unit/health/health.routes.test.ts:9-12`.

```ts
export const requireRole = (...roles: Role[]): RequestHandler => {
  const guard: RequestHandler = (req, res, next) => {
    if (!req.user || !isRole((req.user as any).role)) {
      // No/invalid role claim → 401, NOT 403. A token minted before deploy
      // carries no `role`; 401 lets the web client's authFetch silently refresh
      // + retry, so the deploy self-heals instead of 403-ing every logged-in
      // user for 15 min.
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      return next(new HttpError(403, "Forbidden", `Requires role: ${roles.join(", ")}`));
    }
    next();
  };
  (guard as any).roles = roles;   // introspectable by the route-matrix test
  return guard;
};
```

This uses `HttpError` + `next(err)` — **but that only works once PR1 also adds a
global error handler and a 404 handler to `src/app.ts`.** Today there is neither, so a
forwarded error renders Express's default HTML 500 page — and `activity.controller.ts:31,61`
already calls `next(err)`, so that HTML-500 bug is *live in production right now*. The
handler maps `HttpError` → `{ error, detail? }` (matching `src/shared/http-error.ts`)
and everything else → a JSON 500. Fixing it is a prerequisite for consistent 403s and
closes a pre-existing defect in the same commit.

### Role → endpoint matrix (all 32 authenticated)

Principle: **admin** = everything; **medico** = clinical read + write on studies;
**investigador** = read-only, PHI-free, no writes and no external publication.

**Studies — `src/modules/studies/studies.routes.ts` (10)**

| Route | admin | medico | investigador |
|---|---|---|---|
| `GET /api/studies` | ✓ | ✓ | ✓ *redacted* |
| `GET /api/studies/:id` | ✓ | ✓ | ✓ *redacted* |
| `DELETE /api/studies/:id` | ✓ | ✗ | ✗ |
| `GET /api/v1/studies` | ✓ | ✓ | ✓ *redacted* |
| `GET /api/v1/studies/:id/instances` | ✓ | ✓ | ✓ |
| `GET /api/v1/studies/:id/file` | ✓ | ✓ | ✓ *anonymized* |
| `GET /api/v1/studies/:id/instances/:iid/file` | ✓ | ✓ | ✓ *anonymized* |
| `GET /api/v1/studies/:id/thumbnail` | ✓ | ✓ | ✓ |
| `GET /api/v1/studies/:id/zenodo` | ✓ | ✓ | ✓ |
| `POST /api/v1/studies/:id/zenodo/check` | ✓ | ✓ | ✗ |

**Upload — `src/modules/upload/upload.routes.ts` (2)** — `POST /api/v1/studies/upload`
and its legacy alias `POST /api/instances`: admin + medico. Investigador ✗.

**Activity — `src/modules/activity/activity.routes.ts` (2)** — the audit log is
admin-only: `GET /` and `GET /export` → admin.

**Zenodo — `src/modules/zenodo/zenodo.routes.ts` (18)** — currently one blanket
`zenodoRouter.use(requireAuth)` at `:13`. **Split it**: drop the blanket `use`, put
`requireAuth, requireRole(...)` on each of the 18 routes.

| Group | Routes | Allowed |
|---|---|---|
| Credentials & sync config | `POST /config`, `DELETE /config/:environment`, `GET/PUT /config/sync`, `POST /config/sync/run` | admin |
| Operational read | `GET /config/status`, `GET /config/sync/logs`, `GET /config/sync/status`, `GET /health`, `GET /quota` | admin, medico |
| Public-corpus search | `GET /search`, `GET /records/:recordId`, `GET /resolve` | all three — Zenodo's own public data, no local PHI |
| Import | `POST /import`, `GET /imports/:importId` | admin, medico |
| Publish | `POST /publish`, `GET /depositions/:depositionId`, `POST /depositions/:depositionId/retry` | admin — irreversible and outward-facing |

**Stays public:** `/auth/login`, `/auth/refresh`, `/auth/logout`, `/api/livez`,
`/api/readyz`, `/api/health`, `/api/docs*`. Plus the two new invite routes below.

### Docs

`backend/docs/rbac.md` — English (matching `zenodo.md`, the API-reference model):
role definitions, the full route→role table above, the 403 body shape, `curl`
examples with `# Expected: 403 {"error":"Forbidden",...}` comments, and the
15-minute stale-token caveat. Retract the "no roles" claims in
`zenodo.routes.ts:7-9` and `docs/zenodo.md:3` in the same PR.

`src/openapi.ts` is a hand-maintained 713-line object (no swagger-jsdoc): add `role`
to the `AuthUser` and `LoginResponse` schemas and a shared `403` response. Zenodo's
18 routes, activity's 2, and the 2 study-zenodo routes are undocumented today —
out of scope, note it rather than fixing it here.

---

## Part 2 — User management panel (PR 2)

New `src/modules/users/` following the standard
routes→controller→service→repository layering. Every route
`requireAuth, requireRole("admin")`.

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/v1/users` | list (id, **name**, email, role, status, has_password, **last_login_at**) |
| `POST` | `/api/v1/users` | create with **name** + email + role, password NULL, status `invited` → issues invite → sends mail |
| `PATCH` | `/api/v1/users/:id/role` | assign / revoke role |
| `PATCH` | `/api/v1/users/:id/status` | block / enable (`blocked` ⇄ `active`) |
| `DELETE` | `/api/v1/users/:id` | **soft-delete**: set `status='deleted'`, revoke all refresh tokens |
| `POST` | `/api/v1/users/:id/invite` | re-issue + resend the code |

**`DELETE` is a soft-delete**, not a row removal — sets `status='deleted'` and revokes
refresh tokens. A hard `DELETE` orphans `audit_log.user_id` and `zenodo_config.created_by`
(FKs with no `ON DELETE`). A deleted user is hidden from the list, refused at login
(same generic 401 as blocked), and cannot be un-deleted from the panel (re-create if
needed). `GET /api/v1/users` filters out `status='deleted'` by default.

The list surfaces **`last_login_at`** per user (US-H04); the create form takes
**`name`**; both flow through the service + repository unchanged in shape.

**Self-lockout guards** (service layer, `HttpError(409, …)`): an admin cannot block,
delete, or demote themselves. Reject demoting/blocking/deleting the **last remaining
admin** — and this last-admin count must be done under `SELECT ... FOR UPDATE` in a
transaction, else two concurrent demotions each read "2 admins" and both succeed,
locking everyone out.

**Blocking is enforced at the two doors that matter**: `POST /auth/login` refuses a
blocked user (same generic 401 body as bad credentials — do not disclose account
state), and `PATCH .../status` revokes every row in `refresh_tokens` for that user,
so the ≤15 min access token is the entire residual window.

**Audit**: `src/shared/audit.ts` already has `logAction({userId, action, resourceId,
ip, detail})` writing to `audit_log` (which has `user_id`, `ip`, `detail JSONB`).
Only `ZENODO_*` actions exist. Add `USER_CREATED`, `USER_ROLE_CHANGED`,
`USER_BLOCKED`, `USER_UNBLOCKED`, `USER_DELETED`, `INVITE_SENT`, `INVITE_REDEEMED` —
this is exactly what that table is for.

### Frontend (`web/src`, then vendored to `desktop`)

- **New third tab** on the server screen — `tab-usuarios` / `panel-usuarios`, rendered
  only for `admin`. Markup next to the existing two: tablist at
  `web/src/index.html:1442`, panels at `:1540` / `:1786`.
- `web/src/server-screen/server-screen.ts` — three edits: add `"usuarios"` to the
  `ServerTab` type (`:33`) and the `TABS` array (`:40`); replace the binary ternary
  at `:153` (`btn.id === "tab-cargar" ? "cargar" : "buscar"`) with an id→tab lookup;
  extend `renderForSession()` (`:71-82`) to hide the tab for non-admins.
- `web/src/auth/auth.ts` — add `role` to `AuthUser` (`:19-22`), read it in
  `decodeToken()` (`:72-89`), export `getCurrentRole()`. The existing
  `onAuthChange` → `updateAuthUI()` pipeline then drives visibility with no new
  plumbing, and `doRefresh()` already re-decodes claims, so a role change propagates
  on the next refresh. `decodeToken`'s own comment — *"display-only claims off a
  token the server will verify anyway — nothing here is a security decision"* —
  stays true and should be preserved: the tab hiding is cosmetic, the 403 is the
  boundary.
- `authFetch` (`:241-258`) — add a **403 branch**. Today a 403 falls into every
  caller's generic `if (!res.ok)` and renders as a nondescript error. A 403 must not
  trigger the refresh/login escalation (that path is for 401 only).
- New `web/src/admin/` feature folder — users list (name, email, role, status,
  **last-access** column), create form (**name** + email + role), block/enable, and
  **delete** (soft) — following `explorer.ts`'s fetch→render pattern and
  `login-form.ts`'s `data-*` field lookup + `setBusy` conventions. Keep pure logic
  DOM-free so `node:test` can cover it without jsdom. Format `last_login_at` through
  the existing date helper the explorer already uses; render "—" when never logged in.

**Non-negotiable web gates:** i18n keys in **both** `locales/en.ts` and
`locales/es.ts` (`i18n.test.ts` asserts identical key sets), `escapeHtml`/`escapeAttr`
on every interpolation, `onLocaleChange` re-render for dynamic markup, roving
tabindex on the new tab, **no new runtime dependency**.

**Vendoring:** `desktop/src/renderer/` is a verbatim rsync of `web/src` and must
never be hand-edited. Per PR touching the frontend: change `web/src` → commit in
`web` → in `desktop/` run `make sync-web`, then `make parity` (expects empty
`diff -rq`) → commit `src/renderer` + `.web-sync`.

---

## Part 3 — Invite flow (PR 3)

Migration 007:

```sql
CREATE TABLE IF NOT EXISTS user_invites (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_invites_user_id ON user_invites(user_id);
```

Deliberately shaped like `refresh_tokens`: the code is stored **SHA-256 hashed**
(`consumed_at` plays `revoked_at`'s role), so a DB leak yields no redeemable codes.
Reuse the hashing + single-atomic-`UPDATE ... RETURNING` consumption pattern already
proven in `src/modules/auth/refresh-token.service.ts` — it exists precisely to close
the reuse race and applies verbatim here. Code = `crypto.randomBytes(24)` base64url,
TTL 48 h, and issuing a new invite invalidates the previous one.

Two new **public** routes on the auth router, both behind the existing
`rate-limit.middleware`:

| Method | Path | Does |
|---|---|---|
| `GET` | `/auth/invite/:code` | validate → `{ email }` so the UI can name the account. 404 on invalid/expired/consumed. |
| `POST` | `/auth/accept-invite` | `{ code, password }` → set password (bcrypt, same cost as login), consume the invite, return the normal `{ accessToken, refreshToken, user }` so the user lands logged in |

Password strength is validated by whatever `modules/auth/password.service.ts`
already enforces — reuse it, don't add a second rule set.

**Mail:** `src/shared/mailer.ts` — `nodemailer` (the one new backend dependency),
configured from `SMTP_HOST/PORT/USER/PASS/FROM` + `APP_BASE_URL`, all read through
`src/config/env.ts` (the single place `process.env` is touched). When `SMTP_HOST` is
unset, `sendInvite()` logs the invite link to stdout instead of throwing — dev, CI
and the integration suite work with no mail server. Templates in both `es` and `en`.

While adding the `SMTP_*` vars, fix `backend/.env.example`: it is malformed around
Orthanc (`ORTHANC_PASSWORD=` twice, plus a bare `admin` on its own line) and CI does
`cp .env.example .env`.

**Frontend:** a public accept-invite surface reachable without a session — a screen
in the existing `src/shared/screen.ts` registry, entered from a `?invite=<code>` URL
parameter, that calls `GET /auth/invite/:code`, shows the email, takes a password,
posts it, and drops straight into the authenticated app.

---

## Part 4 — Investigador PHI redaction (PR 4)

Studies sit in Orthanc with **full PHI** — `web/src/utils/dicom-anonymizer.ts` is
imported only by `services/export-service.ts:9`, i.e. anonymization happens on export
today, never on ingest. A live read-only check confirmed it: `PatientID`,
`PatientName`, `PatientSex`, `PatientAge`, `PatientWeight`, `StudyDate` are all
present on stored instances. So redaction must happen **on read**, in the backend —
never in the browser, which is exactly the boundary an investigador account is meant
not to trust.

Four seams:

1. **Metadata** — `src/modules/studies/study-redaction.ts` (new): a pure, I/O-free
   `redactStudy(row, role)` applied in the studies **service** layer to every row
   from `findStudies` and `findStudyZenodoMeta` (both return `patient_name`;
   `findStudies` also returns `patient_id`). For `investigador`: `patient_name` →
   `"ANONYMIZED"`, `patient_id` → a deterministic `sha256(patient_id)` prefix so
   studies stay groupable per subject without carrying identity. `modality`,
   `study_description`, `study_date`, `uploaded_at`, `num_instances` pass through —
   they are the research payload. Pure function ⇒ cheap, real unit tests.

2. **DICOM headers** — `getInstanceTags` for an investigador is filtered against a
   new `src/shared/phi-tags.ts`, a backend port of the 20-tag `PII_TAGS` list in
   `web/src/utils/dicom-anonymizer.ts` (PatientName, PatientID, PatientBirthDate,
   PatientSex, OtherPatientIDs/Names, PatientAge, PatientAddress, EthnicGroup,
   PatientComments, InstitutionName/Address, ReferringPhysicianName/Address/Telephone,
   InstitutionalDepartmentName, PhysiciansOfRecord, PerformingPhysicianName,
   NameOfPhysiciansReadingStudy, OperatorsName). One list, two consumers, same
   definition of PHI.

3. **File downloads** — new method on `src/clients/orthanc.client.ts` (the single
   authenticated Orthanc wrapper, which today has no anonymize method):

   ```ts
   anonymizeInstance: (id: string): Promise<AxiosResponse<ArrayBuffer>> =>
     axios.post<ArrayBuffer>(
       `${BASE}/instances/${id}/anonymize`,
       { KeepPrivateTags: false },
       { auth, responseType: "arraybuffer" },
     ),
   ```

   `getStudyFile` / `getInstanceFile` route through it when
   `req.user.role === "investigador"`. **Verify on the first commit of this PR**
   against the running Orthanc (24.1.2, ApiVersion 22) that this returns the
   anonymized DICOM in the response body rather than persisting a new resource —
   it was not confirmed, since confirming it is a write.

4. **Thumbnails/previews** are rendered pixels with no header — unchanged.
   **Known limitation to state in `rbac.md`:** burned-in pixel PHI (common on
   ultrasound/secondary capture) is not removed by any of the above and is out of
   scope for US-21.

---

## Testing

Backend coverage is currently ~97.6% lines and `backend/.codecov.yml` already
enforces **80% project + 80% patch** with `if_ci_failed: error` — that gate *is* the
≥80% acceptance criterion, and it is unforgiving of untested new code.

**One gap must be closed for these tests to mean anything:** backend CI never starts
the server, so every `tests/integration/**` suite self-skips there. Authorization
tests written *only* as integration tests would assert **nothing** in CI. Therefore:

- **The role matrix is unit-tested** — `tests/unit/require-role.test.ts`, using the
  same hand-rolled `makeReq`/`makeRes` + `jest.fn()` shape as the existing
  `tests/unit/auth-middleware.test.ts` (no supertest). Each role × allowed and
  denied, plus missing `req.user` and an unknown role value. This is the suite that
  actually runs on every PR.
- `tests/unit/study-redaction.test.ts` — the pure redaction function, per role.
- `tests/unit/invite-code.test.ts` — generation, hashing, expiry, single-use.
- `tests/integration/rbac.integration.test.ts` — table-driven end-to-end proof over
  the route matrix. `tests/helpers/auth.ts` is 18 lines and knows exactly one user;
  extend it with `getAuthHeaderFor(role)` that caches per role. **Seed the medico and
  investigador accounts through the real admin API in `beforeAll`** rather than via a
  migration — it keeps production migrations free of test fixtures and exercises the
  create-user flow as a side effect.
- Also add `make test-integration-docker` to the backend CI workflow so the
  integration layer stops being decorative. Worth doing; call it out at review as a
  deliberate scope addition.
- Web/desktop: `node:test` via `tsx`, no jsdom — so the admin panel's logic must be
  DOM-free where it is tested. Codecov gate is 70% there.

---

## Delivery — five PRs

Branch `feat/us-21-rbac`, one commit per step (no `Co-Authored-By` trailers).
Backend commits use Conventional Commits (`feat(auth): …`); web/desktop use plain
imperative sentences, matching each repo's recent history.

| PR | Scope | Criteria met |
|---|---|---|
| 1 | 002 landmine fix + migration 006, `role` in JWT (login **and** refresh), `requireRole` + global error/404 handlers, all 32 authenticated endpoints gated (incl. splitting the blanket Zenodo router), `backend/docs/rbac.md`, unit + integration authorization tests | 1, 2, 4, 5 |
| 2 | `modules/users` CRUD + block/enable + **soft-delete** + **name** + **last_login_at** + audit actions; admin tab in `web/src` → vendored to `desktop` | 3 · **US-H04** |
| 3 | `user_invites` + nodemailer/SMTP + `/auth/invite/:code` + `/auth/accept-invite` + accept-invite UI | the create-user flow · **US-H04** |
| 4 | Investigador redaction: `study-redaction.ts`, `phi-tags.ts`, `orthancClient.anonymizeInstance` | "estudios anonimizados" |
| 5 | **Final documentation** — the complete, user-facing docs for **both** features | DoD "documentado" |

**PR5 — final docs (last step, after code lands).** One consolidated documentation
pass covering US-21 *and* US-H04 end to end, so the two tickets are fully written up:

- `backend/docs/rbac.md` — finalized: the three roles, the full 32-route → role
  matrix, the 403/401 body shapes, the 15-min stale-token caveat, and the
  investigador PHI-redaction boundary (incl. the burned-in-pixel limitation).
- `backend/docs/user-management.md` *(new)* — the US-H04 lifecycle: admin create
  (name/email/role), the email-invite + accept-invite flow, block / enable /
  soft-delete semantics, last-access tracking, and the self-/last-admin guards.
- Update `backend/docs/zenodo.md:3` (retract "no roles") and the OpenAPI `role`
  additions land here if not already in PR1.
- `README` / staging notes: the new `SMTP_*`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`,
  `APP_BASE_URL` env vars and the fixed `.env.example`.

Each PR independently reviewable and green. DoD's "code review by ≥1 peer" and
"working in staging" are process steps outside this plan.

---

## Verification

Per user preference, everything runs **in containers** — no host `npm`.

```bash
# backend — unit suite (the CI-enforced gate)
cd backend && docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm ci && npm run test:unit"

# backend — typecheck
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm ci && npx tsc --noEmit"

# backend — full end-to-end on a throwaway stack (postgres + orthanc + backend)
make test-integration-docker

# manual smoke against the running stack
make up && make check
```

Manual 403 proof — the shape `rbac.md` documents:

```bash
TOKEN=$(curl -s localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"investigador@micd.local","password":"..."}' | jq -r .accessToken)

curl -i -X DELETE localhost:3000/api/studies/<id> -H "Authorization: Bearer $TOKEN"
# Expected: 403 {"error":"Forbidden","detail":"Requires role: admin"}

curl -s localhost:3000/api/v1/studies -H "Authorization: Bearer $TOKEN" | jq '.[0]'
# Expected: patient_name == "ANONYMIZED", patient_id pseudonymized
```

**Restart-persistence check for the migration fix** (the landmine's regression test —
do this explicitly, it is the failure this whole section exists to prevent):

```bash
# assign a non-default role, restart, confirm it survived
make restart
docker exec micd-postgres psql -U postgres -d micd \
  -c "SELECT email, name, role, status, last_login_at FROM users;"
```

Frontend, after any `web/src` change:

```bash
cd web  && docker run --rm -v "$PWD":/app -w /app node:22-alpine \
  sh -c "npm ci && npm run build && npm test"
cd ../desktop && make sync-web && make parity   # must print nothing
```

Invite flow with no SMTP configured: the link is printed to the backend logs
(`make logs`) — redeem it against `/auth/accept-invite` to verify end-to-end without
a mail server.
