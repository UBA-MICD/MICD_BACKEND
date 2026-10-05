# Password recovery — design + routemap

Self-service "forgot password" for MICD users. Modelled on the invite flow
(US-H04): a one-time, hashed, expiring code delivered by email, redeemable either
from an emailed link (web) or by typing the code into a dialog (desktop, which
loads from `file://` and can't be reached by a link).

## Flow

```
Login card ── "¿Olvidaste tu contraseña?" ──► Forgot dialog
                                               1. email ──► POST /auth/forgot-password  (always 202)
                                                            └─ if active user: issue code, email it
                                               2. code + new password ──► POST /auth/reset-password
Email link  APP_BASE_URL/?reset=<code> ──► Reset screen
                                               GET /auth/reset-password/:code  → { email } | 404
                                               new password ──► POST /auth/reset-password
POST /auth/reset-password: consume code atomically → set password → revoke every
refresh token + every other reset code → audit → return a fresh session (LoginResult)
```

## Security decisions

| Concern | Decision |
|---|---|
| Account enumeration | `forgot-password` always answers `202 { ok: true }`, whether the email is unknown, invited, blocked or deleted. The lookup + DB write + SMTP send run **after** the response is sent (fire-and-forget), so response time doesn't leak existence either. |
| Code storage | 24-byte random base64url code, stored SHA-256 hashed in `password_resets` (same shape as `user_invites`). DB leak yields nothing redeemable. |
| Lifetime | 1 hour. Issuing a new code invalidates previous unconsumed ones. |
| Reuse race | Consumption is one `UPDATE … RETURNING` (as invites / refresh tokens). |
| Who can reset | Only `status = 'active'` users with a password. Invited users must use their invite; blocked/deleted get nothing. Status is re-checked at redemption (a user blocked after requesting can't redeem). |
| Email bombing | Per-IP limiter (`RATE_LIMIT_PASSWORD_RESET_MAX`, default 10 / 15 min) on all three routes, plus a per-account cooldown: no new code if one was issued < 60 s ago. |
| Session hygiene | On success all the user's refresh tokens are revoked (kills sessions on other devices / an attacker's), outstanding reset codes are consumed, and a fresh session is returned. |
| Password policy | Same single rule as invites (`validatePasswordStrength`, min 8). |
| Audit | `PASSWORD_RESET_REQUESTED` (only when a code is actually issued) and `PASSWORD_RESET_COMPLETED`. |
| URL hygiene (web) | `?reset=` is stripped with `history.replaceState` before any request, same as `?invite=`. |

Out of scope: admin-triggered reset (admin can already re-send an invite to a
blocked/recreated account), changing password while logged in.

## API

| Method | Path | Body | Responses |
|---|---|---|---|
| POST | `/auth/forgot-password` | `{ email, locale? }` | 202 `{ ok: true }`, 400 missing email, 429 |
| GET | `/auth/reset-password/:code` | — | 200 `{ email }`, 404 invalid/expired, 429 |
| POST | `/auth/reset-password` | `{ code, password }` | 200 `LoginResult`, 400 weak password / invalid code, 429 |

## Routemap (branch-per-repo `feat/password-recovery`, one commit per step)

### Backend (`backend`, off `dev`)
1. **docs** — this plan.
2. **migration 015** `password_resets` table + index; register in `migrate.ts`.
3. **service** `modules/auth/password-reset.service.ts` (issue w/ cooldown, find, consume, consume-all) + `AUDIT_ACTIONS` + `user.service.setPassword`.
4. **mailer** `sendPasswordReset` (es/en template, `?reset=` link, stdout fallback when SMTP unset).
5. **auth service + controller + routes + rate limiter + env knob** (`RATE_LIMIT_PASSWORD_RESET_MAX` in env/compose/.env.example).
6. **tests** — unit (`tests/unit/auth/password-reset.test.ts`) + integration (`tests/integration/password-reset.integration.test.ts`).
7. **OpenAPI** entries for the three routes.

Gate: `npx tsc --noEmit` + unit tests in `node:20-alpine`; `make test-integration-docker`.

### Web (`web`, off `dev`)
1. **module** `src/auth/password-reset.ts` — pure helpers (`parseResetCode`, fetchers), reset screen (`?reset=`), forgot dialog (2 steps), unit tests.
2. **markup + i18n** — `reset-screen.html` partial, `forgot-dialog` in `dialogs.html`, link on the auth card, es/en keys; wire in `main.ts`.

Gate: `npm run build && npm test` in `node:22-alpine`.

### Desktop
`make sync-web` + `make parity`. **Deferred:** desktop `dev` is many features
behind `web/dev` (MPR, segmentation, walkthrough, validations…), so a sync would
vendor all of them at once. Do it as part of the next full desktop catch-up.
