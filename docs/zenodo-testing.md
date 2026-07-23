# Zenodo Feature Testing Guide

All examples use `http://localhost:3000`. Replace tokens, IDs, and study IDs with real values.

---

## 0. Prerequisites

### Start the stack

```bash
docker compose up -d
```

Wait for all three containers to be healthy:

```bash
docker compose ps
```

### Test user

A shared test/development user (`test@micd.local` / `testpassword`) is seeded
automatically by the database migrations on startup — nothing to insert by hand.

### Seed a study in the local DB

The publish endpoint looks up the study in the local `studies` table (not directly in Orthanc). Insert a row pointing to an Orthanc study that has `anonymized_at` set:

```bash
# First upload DICOMs to Orthanc and get the study ID
STUDY_ID=$(curl -s http://localhost:8042/studies -u orthanc:orthanc | jq -r '.[0]')

# Then insert it into the local DB
docker compose exec postgres psql -U micd -d micd -c "
INSERT INTO studies (orthanc_study_id, orthanc_instance_id, sop_instance_uid, anonymized_at)
VALUES (
  '$STUDY_ID',
  'YOUR-INSTANCE-ID',
  'YOUR-SOP-UID',
  NOW()
) ON CONFLICT DO NOTHING;
"
```

> **Tested values:** `orthanc_study_id = 6fbf0b01-6c97a45c-6ba1f385-136ebe7e-98953809`

### Get an auth token

Log in with the seeded test user:

```bash
TOKEN=$(curl -s http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@micd.local","password":"testpassword"}' | jq -r '.accessToken')
echo $TOKEN
```

Set `TOKEN` in your shell before running any curl commands below. Access tokens expire after 15 minutes — re-login (or use `/auth/refresh`) when you get 401s.

### Verify the stack is up

```bash
curl http://localhost:3000/api/v1/zenodo/config/status \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "sandbox": { "configured": false, ... }, "production": { ... } }`

---

## 1. Credential management

**Store a Zenodo token:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "environment": "sandbox",
    "token": "your-zenodo-sandbox-token"
  }'
```

Expected: `200` with `{ "status": "connected", "environment": "sandbox", "hint": "xxxx...XXXX" }`

**Check connection status:**

```bash
curl http://localhost:3000/api/v1/zenodo/config/status \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "sandbox": { "configured": true, ... }, "production": { "configured": false, ... } }`

**Remove a token:**

```bash
curl -X DELETE http://localhost:3000/api/v1/zenodo/config/sandbox \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `204`

---

## 2. Publish anonymized study

> Requires: Zenodo sandbox token stored (section 1) and a study in the local DB with `anonymized_at` set (section 0).

**Publish:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orthanc_study_id": "6fbf0b01-6c97a45c-6ba1f385-136ebe7e-98953809",
    "environment": "sandbox",
    "title": "Test CT Dataset",
    "description": "Anonymized CT lung scan for testing.",
    "authors": [{ "name": "Doe, Jane", "affiliation": "UBA" }],
    "keywords": ["CT", "DICOM", "test"],
    "license": "cc-by-4.0"
  }'
```

Expected: `{ "deposition_id": 1, "doi": "10.5072/zenodo.561205", "files_uploaded": 1, "total_bytes": 9084 }`

**Poll deposition status** (use the `deposition_id` from the publish response):

```bash
curl http://localhost:3000/api/v1/zenodo/depositions/1 \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "deposition": { "status": "published", "doi": "10.5072/zenodo.561205", ... }, "files": [...] }`

**Test error — study not found:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/publish \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "orthanc_study_id": "non-existent",
    "environment": "sandbox",
    "title": "Test", "description": "Test", "authors": [{"name": "Test"}]
  }'
# Expected: 404 { "error": "Estudio no encontrado", "code": "study_not_found" }
```

**Test error — study not anonymized:**

Insert a study without `anonymized_at`, then publish it.
```bash
# Expected: 422 { "code": "not_anonymized" }
```

**Test error — no credentials:**

Delete the token (section 1), then attempt publish.
```bash
# Expected: 422 { "code": "no_credentials" }
```

---

## 3. Search Zenodo records

**Basic search:**

```bash
curl "http://localhost:3000/api/v1/zenodo/search?q=CT&environment=sandbox" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "records": [...], "total": N, "page": 1, "size": 20 }`

**With filters:**

```bash
curl "http://localhost:3000/api/v1/zenodo/search?q=CT&file_type=dcm&date_from=2023-01-01&date_to=2026-12-31&size=5&environment=sandbox" \
  -H "Authorization: Bearer $TOKEN"
```

**Get a specific record** (use a real record ID from the search results or the published one):

```bash
curl "http://localhost:3000/api/v1/zenodo/records/561205?environment=sandbox" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: record detail with `files[]` array and `importable: true/false`.

**Test no results:**

```bash
curl "http://localhost:3000/api/v1/zenodo/search?q=xyzthiswillnevermatch&environment=sandbox" \
  -H "Authorization: Bearer $TOKEN"
# Expected: { "records": [], "total": 0 }
```

---

## 4. Import from Zenodo

> Use a real record ID from the sandbox. The record published in section 2 (`561205`) works.

**Import files from a record:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": 561205,
    "environment": "sandbox",
    "files": [
      { "fileKey": "2339bb3d-902b7d65-a57dcdd6-4c4a1e0a-e5fb37fe.dcm" }
    ],
    "overwrite_duplicates": false
  }'
```

Expected: `{ "import_id": N, "imported": 1, "duplicates": 0, "failed": 0, "results": [...] }`

**Test duplicate handling:**

Run the same import again without `overwrite_duplicates`:
```bash
# Expected: { "duplicates": 1, "imported": 0, "failed": 0 }
```

**Poll import job:**

```bash
curl http://localhost:3000/api/v1/zenodo/imports/1 \
  -H "Authorization: Bearer $TOKEN"
```

**Test overwrite:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": 561205,
    "environment": "sandbox",
    "files": [
      { "fileKey": "2339bb3d-902b7d65-a57dcdd6-4c4a1e0a-e5fb37fe.dcm" }
    ],
    "overwrite_duplicates": true
  }'
# Expected: { "imported": 1, "duplicates": 0 }
```

**Test ZIP skip:**

Include a `.zip` filename in the `files` array. Expected: that file returns `{ "status": "skipped" }`.

**Test non-importable record:**

Use a record with no `.dcm` files. Expected: `422`.

---

## 5. Metadata sync

**Check current schedule:**

```bash
curl http://localhost:3000/api/v1/zenodo/config/sync \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "interval_hours": 24, "last_run_at": null, "valid_intervals": [6, 12, 24, 168] }`

**Update the schedule:**

```bash
curl -X PUT http://localhost:3000/api/v1/zenodo/config/sync \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "interval_hours": 12 }'
# Expected: 200 with updated config
```

**Disable sync:**

```bash
curl -X PUT http://localhost:3000/api/v1/zenodo/config/sync \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "interval_hours": null }'
```

**Test invalid interval:**

```bash
curl -X PUT http://localhost:3000/api/v1/zenodo/config/sync \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "interval_hours": 48 }'
# Expected: 400
```

**Trigger manual sync:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/config/sync/run \
  -H "Authorization: Bearer $TOKEN"
# Expected: { "log_id": N, "records_checked": N, "new_versions": N, "errors": 0 }
```

**View sync history:**

```bash
curl "http://localhost:3000/api/v1/zenodo/config/sync/logs?limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 6. Quota and rate limit

```bash
curl "http://localhost:3000/api/v1/zenodo/quota?environment=sandbox" \
  -H "Authorization: Bearer $TOKEN"
```

Expected:

```json
{
  "environment": "sandbox",
  "used_bytes": 9084,
  "limit_bytes": 53687091200,
  "percent_used": 0.0,
  "alert": false,
  "alert_message": null,
  "rate_limit": {
    "requests_last_minute": 0,
    "throttle_at": 50,
    "limit": 60
  }
}
```

**Trigger the quota alert** (for manual testing): temporarily set `ZENODO_QUOTA_LIMIT_GB=1` in the container environment and publish a file larger than 0.9 GB.

---

## Running automated tests

```bash
# All zenodo unit tests
npx jest --testPathPatterns="zenodo" --no-coverage

# Rate limit service only
npx jest --testPathPatterns="zenodo-rate-limit" --no-coverage

# Integration tests (requires running stack: docker compose up)
npx jest --testPathPatterns="integration" --no-coverage
```
