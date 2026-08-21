# RBAC — roles and per-endpoint authorization

> US-21. Roles, per-endpoint 403 enforcement, and investigador PHI redaction.
> User lifecycle (create/invite/block/delete) is in
> [`user-management.md`](./user-management.md). Original design:
> [`us-21-rbac-plan.md`](./us-21-rbac-plan.md).

## Roles

Every user carries exactly one role (`users.role`, NOT NULL, CHECK-constrained),
signed into the JWT access token and enforced per endpoint by `requireRole`.

| Role | Intent |
|---|---|
| `admin` | Everything: study read/write, uploads, the audit log, Zenodo credentials + publication, and (PR2) user management. |
| `medico` | Clinical read + write on studies and uploads; operational Zenodo reads + import. No user management, no audit log, no publication. |
| `investigador` | Read-only, **PHI-free**. Sees studies and images with patient identity stripped (PR4). No writes, no uploads, no external publication. |

## How enforcement works

- `requireAuth` verifies the Bearer access token and populates `req.user`
  (including `role`).
- `requireRole(...roles)` runs next:
  - **Missing or invalid role claim → `401`** (not 403). A token minted before
    this feature deployed carries no role; 401 lets the web client silently
    refresh + retry, so a deploy self-heals instead of 403-ing every logged-in
    user for the ~15-minute access-token lifetime.
  - **Authenticated but wrong role → `403`** with body
    `{ "error": "Forbidden", "detail": "Requires role: <allowed>" }`.

**Stale-token caveat:** a role or status change takes up to the access-token
lifetime (~15 min) to take full effect, because `requireAuth` does not re-read
the DB on every request. Blocking additionally revokes refresh tokens (PR2), so
15 minutes is the entire residual window.

## Route → role matrix (32 authenticated endpoints)

### Studies — `/api/studies*`, `/api/v1/studies*`
| Route | admin | medico | investigador |
|---|:--:|:--:|:--:|
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

*redacted / anonymized* mark investigador PHI handling (PR4):
- **Metadata** (`*redacted*`): `patient_name` → `"ANONYMIZED"`, `patient_id` → a
  deterministic pseudonym; the patient-name/id search is disabled for
  investigador so it can't be used as an oracle.
- **File downloads** (`*anonymized*`): the DICOM is passed through Orthanc's
  anonymize (PHI tags stripped; study/series/SOP UIDs kept so the viewer can
  still stack slices) and returned without persisting a new resource.
- **Known limitation:** burned-in **pixel** PHI (text baked into the image,
  common on ultrasound/secondary capture) is **not** removed by any of the
  above and is out of scope for US-21.

### Upload — `/api/v1/studies/upload`, `/api/instances`
| Route | admin | medico | investigador |
|---|:--:|:--:|:--:|
| `POST /api/v1/studies/upload` | ✓ | ✓ | ✗ |
| `POST /api/instances` (legacy alias) | ✓ | ✓ | ✗ |

### Activity (audit log) — `/api/v1/activity`
| Route | admin | medico | investigador |
|---|:--:|:--:|:--:|
| `GET /` | ✓ | ✗ | ✗ |
| `GET /export` | ✓ | ✗ | ✗ |

### Zenodo — `/api/v1/zenodo`
| Group | Routes | admin | medico | investigador |
|---|---|:--:|:--:|:--:|
| Credentials & sync config | `POST /config`, `DELETE /config/:environment`, `GET/PUT /config/sync`, `POST /config/sync/run` | ✓ | ✗ | ✗ |
| Operational read | `GET /config/status`, `GET /config/sync/logs`, `GET /config/sync/status`, `GET /health`, `GET /quota` | ✓ | ✓ | ✗ |
| Public-corpus search | `GET /search`, `GET /records/:recordId`, `GET /resolve` | ✓ | ✓ | ✓ |
| Import | `POST /import`, `GET /imports/:importId` | ✓ | ✓ | ✗ |
| Publish | `POST /publish`, `GET /depositions/:depositionId`, `POST /depositions/:depositionId/retry` | ✓ | ✗ | ✗ |

### Public (no token)
`POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`,
`GET /api/livez`, `GET /api/readyz`, `GET /api/health`, `GET /api/docs*`.

## Response shapes

```jsonc
// 401 — no/invalid/expired token, or a role-less legacy token
{ "error": "Unauthorized" }

// 403 — authenticated, wrong role
{ "error": "Forbidden", "detail": "Requires role: admin" }
```

## Verifying

```bash
# Unit (runs in CI): the full matrix + the guard behavior
npm run test:unit   # tests/unit/rbac-matrix.test.ts, require-role.test.ts

# End-to-end over HTTP against a throwaway stack
make test-integration-docker   # tests/integration/rbac.integration.test.ts
```
