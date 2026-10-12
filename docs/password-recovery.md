# Password recovery

Self-service "forgot password" for MICD accounts. A user who can't sign in asks
for a one-time code by email, then uses it to choose a new password and is
signed straight back in. Admins are not involved.

This doc covers how the feature works and how it's built. The original design
and step plan is [`password-recovery-plan.md`](./password-recovery-plan.md).
User lifecycle context (statuses, invites) is in
[`user-management.md`](./user-management.md).

## User flow

There are two ways to redeem a code. Both use the same backend endpoints.

**1. From the login card (web and desktop).**
The auth card on the server screen has a **"¿Olvidaste tu contraseña?"** link.
It opens a two-step dialog:

1. **Request:** the user enters their email (pre-filled from the login form if
   they had already typed it) and presses **Enviar código**. The dialog always
   moves on to step 2 with *"Si existe una cuenta activa para X, te enviamos un
   código…"*. It never says whether the account exists.
2. **Reset:** the user pastes the code from the email, types a new password and
   presses **Cambiar contraseña e ingresar**. On success the dialog closes and
   the app is signed in.

**"Ya tengo un código"** jumps straight to step 2, and **"Pedir un código
nuevo"** goes back to step 1. Desktop only has this path: Electron loads the
app from `file://`, so an email link can't open it.

**2. From the emailed link (web).**
The email contains `APP_BASE_URL/?reset=<code>`. Opening it:

1. removes the code from the address bar (`history.replaceState`) before any
   request is made, so it can't stay in history or leak through `Referer`;
2. shows the **reset screen** (`#reset-screen`) with *"Elegí una contraseña
   nueva para <email>"*;
3. after the new password is submitted, signs the user in and shows the viewer.

An invalid, expired or already-used link shows an error on the same screen and
no form.

## Sequence

```
browser                         backend                              DB / mail
───────                         ───────                              ─────────
POST /auth/forgot-password ───► validate body
       {email, locale}          ◄── 202 {ok:true}   (sent immediately)
                                then, in the background:
                                findUserByEmail ───────────────────► users
                                active + has password?  no → stop
                                issueReset(userId) ────────────────► password_resets
                                  (cooldown 60 s?  yes → stop)        lock user row,
                                                                      consume old codes,
                                                                      insert new hash
                                audit PASSWORD_RESET_REQUESTED ────► audit_log
                                sendPasswordReset ─────────────────► SMTP  (or stdout)

GET /auth/reset-password/:code ► findValidReset ───────────────────► join users
                                ◄── 200 {email} | 404                 (status = active)

POST /auth/reset-password ────► validatePasswordStrength  (before touching the code)
       {code, password}         consumeReset  (atomic UPDATE…RETURNING)
                                user still active?  no → 400
                                setPassword(bcrypt)
                                revokeAllRefreshTokensForUser  → other sessions end
                                consumeAllResetsForUser        → other codes die
                                stampLastLogin, audit PASSWORD_RESET_COMPLETED
                                ◄── 200 LoginResult {accessToken, refreshToken, user}
```

## API

All three routes are public (`/auth/*`) and share one per-IP rate limiter.

| Method | Path | Body | Responses |
|---|---|---|---|
| `POST` | `/auth/forgot-password` | `{ email, locale? }` (`locale`: `es` default, or `en`, picks the email language) | **202** `{ok:true}` always · 400 email missing · 429 |
| `GET` | `/auth/reset-password/:code` | — | 200 `{email}` · 404 invalid/expired/used, or the account is no longer active · 429 |
| `POST` | `/auth/reset-password` | `{ code, password }` | 200 `LoginResult` (same shape as `/auth/login`) · 400 missing fields / password < 8 chars / invalid code · 429 |

Full schemas are in Swagger at `/api/docs` (`src/openapi.ts`).

## Security properties

| Threat | Mitigation |
|---|---|
| **Account enumeration** | `forgot-password` answers `202` for every email. The lookup, DB write and SMTP send all run *after* the response is flushed, so the response time doesn't reveal anything either. The UI wording never says a code was sent, only that one was sent *if* an account exists. |
| **DB leak** | Codes are stored only as SHA-256 hashes (`code_hash`). A dump contains nothing redeemable. |
| **Brute force / guessing** | 24 random bytes (base64url, 192 bits), a 1-hour expiry, and the per-IP limiter. |
| **Replay / double redeem** | Consumption is one `UPDATE … WHERE consumed_at IS NULL AND expires_at > NOW() RETURNING`. Two concurrent redemptions can't both succeed. |
| **Stale codes** | Issuing a new code consumes the previous ones. A successful reset consumes all outstanding ones. |
| **Email bombing** | Per-IP limiter, plus a per-account cooldown: no new code within 60 s of the last one (`RESET_COOLDOWN_SECONDS`). The user row is locked `FOR UPDATE` so concurrent requests can't both pass the check. |
| **Hijacked session** | A reset revokes **every** refresh token of the account, so an attacker's session on another device ends within the 15-minute access-token lifetime. |
| **Disabled accounts** | Only `active` accounts with a password get a code. `invited` users must use their invite, and `blocked`/`deleted` users get nothing. Status is **re-checked at redemption**, so blocking a user after they asked for a code still stops them. |
| **Weak password** | The same single rule as invites (`validatePasswordStrength`, min 8). It runs *before* consuming the code, so a rejected password doesn't burn it. |
| **Code in URL** | The web client strips `?reset=` before making any request. |
| **Audit** | `PASSWORD_RESET_REQUESTED` (only when a code is actually issued) and `PASSWORD_RESET_COMPLETED` go to `audit_log` with user id and IP. |

## How it's built

### Backend (`backend/`)

| Piece | File | Notes |
|---|---|---|
| Table | `src/db/migrations/015_password_resets.ts` | `id, user_id → users ON DELETE CASCADE, code_hash UNIQUE, expires_at, consumed_at, created_at` + index on `user_id`. Same shape as `user_invites` (007). Idempotent like every migration. |
| Code store | `src/modules/auth/password-reset.service.ts` | `issueReset` (transaction: lock user, cooldown check, consume old codes, insert), `findValidReset`, `consumeReset`, `consumeAllResetsForUser`. Reuses `generateInviteCode`/`hashInviteCode` from `invite.service.ts`. |
| Business logic | `src/modules/auth/auth.service.ts` | `requestPasswordReset`, `getResetEmail`, `resetPassword`. Throw `HttpError`. |
| HTTP | `src/modules/auth/auth.controller.ts`, `auth.routes.ts` | `forgotPasswordHandler` sends 202 first, then runs the service fire-and-forget (errors are logged, never surfaced). |
| Password write | `src/modules/auth/user.service.ts` → `setPassword` | Unlike `setPasswordAndActivate`, it doesn't touch `status`. |
| Email | `src/shared/mailer.ts` → `sendPasswordReset`, `resetLink` | es/en templates. With `SMTP_HOST` unset it logs `[mailer] SMTP not configured — password reset code for <email>: <code> (link: …)` instead, which dev, CI and e2e rely on. |
| Rate limit | `src/middleware/rate-limit.middleware.ts` → `passwordResetRateLimiter` | Its own budget, separate from login/invite, so recovery traffic can't lock out logins. |
| Audit actions | `src/shared/audit.ts` | `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED`. |
| API docs | `src/openapi.ts` | The three routes. |

### Web client (`web/`, vendored into `desktop/`)

| Piece | File | Notes |
|---|---|---|
| Logic | `src/auth/password-reset.ts` | Pure helpers (`parseResetCode`, `requestPasswordReset`, `fetchResetEmail`, `submitPasswordReset`) + `initResetScreen`, `enterResetFlowIfPresent`, `initForgotPasswordDialog`. Mirrors `accept-invite.ts` and reuses its `validateInvitePassword`. A successful reset calls `adoptSession`. |
| Reset screen | `src/html/partials/reset-screen.html` | Registered as screen `"reset"` (`shared/screen.ts`). |
| Dialog | `src/html/partials/dialogs.html` → `#forgot-dialog` | Two forms (`data-forgot-request-form`, `data-forgot-reset-form`) toggled by `hidden`. Escape is blocked while a request is in flight (`data-dialog-busy`). |
| Entry link | `src/html/partials/server-screen/auth-card.html` → `[data-forgot-open]` | |
| Wiring | `src/main.ts` | `enterResetFlowIfPresent()` runs right after the invite check. On success it does the same as invite acceptance: viewer screen, repaint auth UI, load explorer. |
| Strings | `src/i18n/locales/{es,en}.ts` | `auth.forgotPassword`, `reset.*`. The dynamic "sent to <email>" line re-renders on locale change. |

Related fix shipped with this feature: `getPathologies()`
(`src/viewer/segmentation/segmentation-api.ts`) no longer calls `authFetch` for
a guest. Its 401 opened the login prompt on page load, which covered the
`?reset=` and `?invite=` screens.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `SMTP_HOST` (+ `SMTP_PORT/USER/PASS/FROM`) | unset | Unset → codes are logged to stdout instead of emailed. |
| `APP_BASE_URL` | `http://localhost:3000` | Base of the emailed link (`APP_BASE_URL/?reset=<code>`). Must be the **web** origin. |
| `RATE_LIMIT_PASSWORD_RESET_MAX` | `10` | Requests per IP per `RATE_LIMIT_WINDOW_MS` (15 min) across the three routes. The integration and e2e stacks raise it to 100. |

Expiry (1 h) and cooldown (60 s) are constants in `password-reset.service.ts`.

## Operating it

- **"I never got the email."** Check the backend log for `[auth] password reset
  request failed` (SMTP error) and `audit_log` for `PASSWORD_RESET_REQUESTED`.
  No audit row means the account isn't `active`, the email was mistyped, or the
  60 s cooldown swallowed a repeat request.
- **Find a code without SMTP (dev):**
  `docker logs micd-backend 2>&1 | grep "password reset code for"`.
- **Invalidate all pending codes for a user:**
  `UPDATE password_resets SET consumed_at = NOW() WHERE user_id = <id> AND consumed_at IS NULL;`
- **Invited users** who lost their invite email need the admin to re-send the
  invite. Password recovery ignores them on purpose.

## Tests

| Layer | Where | Run |
|---|---|---|
| Backend unit | `tests/unit/auth/password-reset.test.ts`, `tests/unit/shared/mailer.test.ts` | `npm run test:unit` (in a container) |
| Backend integration | `tests/integration/password-reset.integration.test.ts`: enumeration, cooldown, invited user ignored, single use, sessions revoked, weak password keeps the code, blocked-after-issue refused | `make test-integration-docker` |
| Web unit | `src/auth/password-reset.test.ts` | `npm test` (in a container) |
| E2E (Cypress) | `testing/cypress/e2e/password-recovery.cy.js`, use cases in `testing/docs/password-recovery-use-cases.md` | see `testing/README.md` |
