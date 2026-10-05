# User management (US-H04)

Admin-driven user lifecycle: create with name/email/role, email-invite so the
user sets their own password, block/enable, and soft-delete — plus last-access
visible to the admin. Authorization for these routes is defined in
[`rbac.md`](./rbac.md); this document is the lifecycle.

## Data model

`users` (migration 006) carries, beyond `id`/`email`/`password`:

| Column | Meaning |
|---|---|
| `role` | `admin` \| `medico` \| `investigador` (NOT NULL, CHECK) |
| `status` | `active` \| `invited` \| `blocked` \| `deleted` (NOT NULL, CHECK) |
| `name` | display name |
| `last_login_at` | stamped on each successful login; shown as "last access" |
| `password` | **nullable** — an `invited` user has none until they redeem their invite |

`user_invites` (migration 007) stores one-time invite codes **SHA-256 hashed**
(never in clear), with a 48h expiry and a `consumed_at` marker; issuing a new
invite invalidates the previous one, and redemption is a single atomic UPDATE.

## Admin API — `/api/v1/users` (all admin-only)

| Method | Path | Does |
|---|---|---|
| `GET` | `/` | list non-deleted users (id, name, email, role, status, has_password, last_login_at) |
| `POST` | `/` | create name+email+role → `invited`, issues + emails an invite |
| `PATCH` | `/:id/role` | change role |
| `PATCH` | `/:id/status` | block ⇄ active (blocking revokes the user's refresh tokens) |
| `DELETE` | `/:id` | **soft-delete**: status `deleted` + revoke refresh tokens |
| `POST` | `/:id/invite` | re-issue + resend the invite (only for an `invited` user) |

**Soft-delete, not row removal.** A hard `DELETE` would orphan
`audit_log.user_id` and `zenodo_config.created_by` (FKs with no `ON DELETE`). A
deleted user is hidden from the list, refused at login (same generic 401 as a
blocked user), and cannot be undeleted from the panel — recreate if needed.

**Guards (HTTP 409).** You cannot demote, block, or delete **your own** account,
and you cannot demote/block/delete the **last effective admin** (role `admin` +
status `active`). The last-admin count runs under `SELECT … FOR UPDATE` inside a
transaction, so two concurrent demotions can't both slip through.

**Audit.** Every action writes to `audit_log`: `USER_CREATED`,
`USER_ROLE_CHANGED`, `USER_BLOCKED`, `USER_UNBLOCKED`, `USER_DELETED`,
`INVITE_SENT`, `INVITE_REDEEMED`.

## Invite / accept flow (public `/auth`)

1. Admin `POST /api/v1/users` → user created `invited`, an invite is issued and
   emailed (link `APP_BASE_URL/?invite=<code>`).
2. `GET /auth/invite/:code` → `{ email }` for a valid code, else 404 — lets the
   accept-invite screen name the account.
3. `POST /auth/accept-invite` `{ code, password }` → validates the password
   (min 8), consumes the code atomically, sets the password, flips status to
   `active`, and returns a live `{ accessToken, refreshToken, user }` so the user
   lands signed in. Both routes are behind a dedicated invite rate limiter
   (separate from the login limiter).

The web app enters the accept-invite screen from the `?invite=<code>` URL and
strips the code from the URL on load (so it can't leak via history or Referer).

## Login effects (US-H04)

On a successful login the backend stamps `last_login_at`. A `blocked` or
`deleted` account is refused with the **same generic 401** as bad credentials,
so login never discloses that an account exists but is disabled. Because
`requireAuth` does not re-read the DB per request, a block takes up to the
access-token lifetime (~15 min) to fully bite — blocking also revokes refresh
tokens, so that window is the entire residual access.

## Configuration

`ADMIN_EMAIL` / `ADMIN_PASSWORD` seed the first admin (migration 006, only when
both are set; the password is hashed in-database). `SMTP_*` configure mail; with
`SMTP_HOST` unset the invite link is logged to stdout instead of sent (dev/CI).
`APP_BASE_URL` builds the invite link. See `.env.example`.

## Password recovery

Active users can reset a forgotten password themselves (email code → new
password). This is separate from invites: invited users are ignored by it.
See [`password-recovery.md`](./password-recovery.md).
