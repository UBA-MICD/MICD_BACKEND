# US-21 / US-H04 — Manual Test Guide (Gherkin)

> **Purpose.** Step-by-step acceptance evidence for **US-21** (RBAC: `admin` /
> `medico` / `investigador`, per-endpoint 403 enforcement, investigador PHI
> redaction) and **US-H04** (admin-driven user lifecycle: create / invite /
> block / soft-delete + last-access). Design lives in
> [`us-21-rbac-plan.md`](./us-21-rbac-plan.md); behaviour reference in
> [`rbac.md`](./rbac.md) and [`user-management.md`](./user-management.md).
>
> Written as Gherkin so each run is repeatable, self-documenting evidence. Fill
> the **Run log** table at the bottom on every execution.

---

## Background / preconditions (do this once before any scenario)

```gherkin
Background:
  Given the stack is running via "make up" and "make check" reports healthy
  And the first admin was seeded from ADMIN_EMAIL / ADMIN_PASSWORD (migration 006)
  And SMTP_HOST is unset, so invite links are printed to "make logs" (dev/CI mode)
  And I have a terminal with "curl" and "jq" available
  And BASE = "http://localhost:3000"
```

**Helper — get an access token for a role:**

```bash
login() {  # usage: login <email> <password>
  curl -s "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | jq -r .accessToken
}
```

---

## Feature: Authentication carries a role claim (US-21)

```gherkin
Feature: The JWT access token carries the user's role

  Scenario: Admin logs in and the token/user reports the admin role
    Given the seeded admin account exists
    When I POST /auth/login with the admin email and password
    Then the response is 200
    And the JSON "user.role" equals "admin"
    And the returned accessToken, when decoded, contains a "role" claim of "admin"

  Scenario: Successful login stamps last access (US-H04)
    Given I note the admin "last_login_at" in the users list
    When I log in again as the admin
    And I re-list users as admin
    Then the admin "last_login_at" has advanced to a more recent timestamp
```

Evidence:

```bash
curl -s "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@micd.local","password":"<ADMIN_PASSWORD>"}' | jq '.user'
# Expect: { ..., "role": "admin", "status": "active", ... }
```

---

## Feature: Role-based enforcement returns 403 / 401 (US-21)

```gherkin
Feature: Each endpoint enforces the role matrix

  Scenario: A medico cannot delete a study (write reserved for admin)
    Given I am logged in as a "medico"
    When I DELETE /api/studies/<id>
    Then the response is 403
    And the body is { "error": "Forbidden", "detail": "Requires role: admin" }

  Scenario: A medico cannot read the audit log (admin-only)
    Given I am logged in as a "medico"
    When I GET /api/v1/activity
    Then the response is 403

  Scenario: An investigador cannot upload a study
    Given I am logged in as an "investigador"
    When I POST /api/v1/studies/upload with a DICOM file
    Then the response is 403

  Scenario: An investigador cannot publish to Zenodo (irreversible, admin-only)
    Given I am logged in as an "investigador"
    When I POST /api/v1/zenodo/publish
    Then the response is 403

  Scenario: All three roles can read the public Zenodo corpus search
    Given I am logged in as any role
    When I GET /api/v1/zenodo/search?q=lung
    Then the response is 200

  Scenario: A legacy role-less token is refreshed, not rejected as 403
    Given a token minted before the RBAC deploy (no "role" claim)
    When I call any role-gated endpoint
    Then the response is 401 (not 403)
    And the web client silently refreshes and retries
```

Evidence (the shape `rbac.md` documents):

```bash
TOKEN=$(login medico@micd.local <pass>)
curl -i -X DELETE "$BASE/api/studies/<id>" -H "Authorization: Bearer $TOKEN"
# Expect: HTTP/1.1 403  {"error":"Forbidden","detail":"Requires role: admin"}
```

---

## Feature: Investigador never sees PHI (US-21 PR4)

```gherkin
Feature: Patient identity is stripped for the investigador role

  Scenario: Study metadata is redacted in the list
    Given I am logged in as an "investigador"
    When I GET /api/v1/studies
    Then every "patient_name" equals "ANONYMIZED"
    And every "patient_id" is a deterministic pseudonym (not the real MRN)
    And "modality", "study_description", "study_date", "num_instances" pass through

  Scenario: The same study read by a medico still shows PHI
    Given I am logged in as a "medico"
    When I GET /api/v1/studies
    Then "patient_name" and "patient_id" contain the real patient identity

  Scenario: DICOM instance tags are filtered for the investigador
    Given I am logged in as an "investigador"
    When I GET /api/v1/studies/<id>/instances
    Then PHI tags (PatientName, PatientID, PatientBirthDate, ...) are absent

  Scenario: Downloaded DICOM files are anonymized for the investigador
    Given I am logged in as an "investigador"
    When I GET /api/v1/studies/<id>/file
    Then the returned DICOM has PHI tags removed
    And study/series/SOP UIDs are preserved so the viewer can still stack slices
    And no new resource is persisted in Orthanc

  Scenario: Known limitation is documented, not fixed
    Given a study with burned-in pixel PHI (e.g. ultrasound capture)
    When an investigador views the thumbnail
    Then the burned-in text is NOT removed (out of scope for US-21, per rbac.md)
```

Evidence:

```bash
TOKEN=$(login investigador@micd.local <pass>)
curl -s "$BASE/api/v1/studies" -H "Authorization: Bearer $TOKEN" | jq '.[0]'
# Expect: patient_name == "ANONYMIZED", patient_id pseudonymized
```

---

## Feature: Admin creates and invites a user (US-H04 PR2/PR3)

```gherkin
Feature: Admin-driven user creation with email invite

  Scenario: Admin creates a user with name, email and role
    Given I am logged in as an "admin"
    When I POST /api/v1/users with name "Dra. Ruiz", email "ruiz@micd.local", role "medico"
    Then the response is 201
    And the user is listed with status "invited" and has_password false
    And an audit entry "USER_CREATED" is written
    And an invite link "APP_BASE_URL/?invite=<code>" appears in "make logs"

  Scenario: The invited user validates the code before setting a password
    Given an invite code from the created user
    When I GET /auth/invite/<code>
    Then the response is 200 and returns { "email": "ruiz@micd.local" }

  Scenario: An invalid or expired code is rejected
    When I GET /auth/invite/<garbage-code>
    Then the response is 404

  Scenario: The user accepts the invite and lands logged in
    Given a valid invite code
    When I POST /auth/accept-invite with { code, password: "<>=8 chars>" }
    Then the response is 200 with { accessToken, refreshToken, user }
    And the user status flips to "active" and has_password true
    And an audit entry "INVITE_REDEEMED" is written

  Scenario: A weak password is rejected on accept
    When I POST /auth/accept-invite with a password shorter than 8 chars
    Then the response is a validation error and the code is NOT consumed

  Scenario: An invite code is single-use
    Given a code already redeemed
    When I POST /auth/accept-invite with the same code again
    Then the response is 4xx (code already consumed)

  Scenario: Re-issuing an invite invalidates the previous code
    Given an invited user with an outstanding code
    When the admin POSTs /api/v1/users/<id>/invite
    Then a new code is emailed
    And the previous code no longer validates via GET /auth/invite/:code
```

---

## Feature: Admin blocks, enables and soft-deletes users (US-H04 PR2)

```gherkin
Feature: Account lifecycle — block, enable, soft-delete

  Scenario: Blocking a user refuses login and revokes refresh tokens
    Given an active "medico" user
    When the admin PATCHes /api/v1/users/<id>/status to "blocked"
    Then that user's refresh tokens are revoked
    And the user's next /auth/login returns the SAME generic 401 as bad credentials
    And an audit entry "USER_BLOCKED" is written

  Scenario: Re-enabling restores login
    Given a blocked user
    When the admin PATCHes status back to "active"
    Then the user can log in again
    And an audit entry "USER_UNBLOCKED" is written

  Scenario: Soft-delete hides the user but preserves the audit trail
    Given an active user
    When the admin DELETEs /api/v1/users/<id>
    Then the user's status becomes "deleted"
    And the user disappears from GET /api/v1/users
    And the user is refused at login with the generic 401
    And the row is NOT removed (audit_log.user_id / zenodo_config.created_by intact)
    And an audit entry "USER_DELETED" is written

  Scenario: Changing a role is audited
    Given an active user
    When the admin PATCHes /api/v1/users/<id>/role to "investigador"
    Then the change takes effect within ~15 min (next token refresh)
    And an audit entry "USER_ROLE_CHANGED" is written
```

---

## Feature: Self-lockout and last-admin guards (US-H04)

```gherkin
Feature: The system cannot be locked out of administration

  Scenario: An admin cannot block/demote/delete their own account
    Given I am logged in as an "admin"
    When I PATCH my own status to "blocked" (or demote my own role, or DELETE myself)
    Then the response is 409

  Scenario: The last effective admin cannot be removed
    Given exactly one admin with role "admin" and status "active"
    When any request tries to demote, block, or delete that admin
    Then the response is 409

  Scenario: Concurrent demotions cannot both slip through
    Given two admins
    When two demotion requests race
    Then at most one succeeds (last-admin count runs under SELECT ... FOR UPDATE)
```

---

## Feature: The role/status survives a restart (US-21 migration landmine)

```gherkin
Feature: Assigned roles persist across restarts

  Scenario: A non-default role is not wiped on reboot
    Given I set a user's role to "investigador"
    When I run "make restart"
    And I query the users table
    Then the user still has role "investigador" and their prior status
    # This is the regression test for the 002 DROP COLUMN landmine.
```

Evidence:

```bash
make restart
docker exec micd-postgres psql -U postgres -d micd \
  -c "SELECT email, name, role, status, last_login_at FROM users;"
```

---

## Feature: Admin panel (web / desktop UI)

```gherkin
Feature: The Usuarios tab is admin-only and drives the lifecycle

  Scenario: The Usuarios tab is visible only to admins
    Given I am logged in on the web app as an "admin"
    Then a third "Usuarios" tab appears on the server screen
    When I log in as a "medico" or "investigador"
    Then the "Usuarios" tab is hidden

  Scenario: Admin runs the full lifecycle from the panel
    Given I am on the Usuarios tab as admin
    Then I see a users list with name, email, role, status and last-access columns
    And "never logged in" renders as "—"
    When I create a user via the form (name + email + role)
    Then the user appears with status "invited"
    And I can block / enable / delete the user from the row

  Scenario: A 403 in the UI does not trigger a re-login loop
    Given a non-admin somehow calls an admin route
    When the server responds 403
    Then authFetch surfaces the error without escalating to refresh/login (401-only path)

  Scenario: Accept-invite screen is reachable without a session
    Given a browser opens "APP_BASE_URL/?invite=<code>"
    Then the accept-invite screen loads and shows the invited email
    And the code is stripped from the URL on load (no leak via history/Referer)
    When I submit a valid password
    Then I land in the authenticated app
```

---

## Automated backing (run alongside the manual pass)

```bash
# Unit — the CI-enforced gate (role matrix, guard behaviour, redaction, invite codes)
cd backend && docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm ci && npm run test:unit"

# End-to-end over HTTP on a throwaway stack
make test-integration-docker
```

---

## Run log (fill on each execution — this is the evidence)

| Date | Tester | Build / commit | Scenarios passed | Failures / notes |
|---|---|---|---|---|
|  |  |  |  |  |
|  |  |  |  |  |
