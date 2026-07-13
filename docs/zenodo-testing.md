# Zenodo Feature Testing Guide

All examples use `http://localhost:3000`. Replace tokens, IDs, and study IDs with real values.

---

## 0. Prerequisites

**Get an auth token** (needed for most endpoints):

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}' \
  | jq -r '.token')
```

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

Expected: `200` with `{ "environment": "sandbox", "token_hint": "xxxx" }`

**Check connection status:**

```bash
curl http://localhost:3000/api/v1/zenodo/config/status \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "sandbox": { "status": "connected", ... }, "production": { ... } }`

**Remove a token:**

```bash
curl -X DELETE http://localhost:3000/api/v1/zenodo/config/sandbox \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `204`

---

## 2. Publish anonymized study

First find a study ID and make sure it's been anonymized (has `anonymized_at` set).

**Publish:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orthanc_study_id": "ORTHANC-STUDY-ID",
    "environment": "sandbox",
    "title": "Test CT Dataset",
    "description": "Anonymized CT lung scan for testing.",
    "authors": [{ "name": "Doe, Jane", "affiliation": "UBA" }],
    "keywords": ["CT", "DICOM", "test"],
    "license": "cc-by-4.0"
  }'
```

Expected: `201` with `{ "deposition_id": ..., "doi": "10.5072/zenodo...", "files_uploaded": N, "total_bytes": N }`

**Test size rejection (no real 50 GB file needed — modify the check in a test env or use force flag):**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    ...same body...,
    "force_large_upload": true
  }'
```

**Poll deposition status:**

```bash
curl http://localhost:3000/api/v1/zenodo/depositions/42 \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "deposition": { "status": "published", "doi": "..." }, "files": [...] }`

**Test error cases:**

```bash
# Not anonymized
curl -X POST http://localhost:3000/api/v1/zenodo/publish \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "orthanc_study_id": "not-anonymized-study-id", "environment": "sandbox", ... }'
# Expected: 422 { "code": "not_anonymized" }

# No credentials
# First delete the token, then publish
# Expected: 422 { "code": "no_credentials" }

# Study not found
curl -X POST http://localhost:3000/api/v1/zenodo/publish \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "orthanc_study_id": "non-existent", "environment": "sandbox", ... }'
# Expected: 404 { "code": "study_not_found" }
```

---

## 3. Search Zenodo records

**Basic search:**

```bash
curl "http://localhost:3000/api/v1/zenodo/search?q=lung+CT&environment=sandbox"
```

Expected: `{ "records": [...], "total": N, "page": 1, "size": 20 }`

**With filters:**

```bash
curl "http://localhost:3000/api/v1/zenodo/search?q=brain&file_type=dcm&date_from=2023-01-01&date_to=2024-12-31&size=5&environment=sandbox"
```

**Get a specific record:**

```bash
curl "http://localhost:3000/api/v1/zenodo/records/1234567?environment=sandbox"
```

Expected: record detail with `files[]` array and `importable: true/false`.

**Test no results:**

```bash
curl "http://localhost:3000/api/v1/zenodo/search?q=xyzthiswillnevermatch"
# Expected: { "records": [], "total": 0, "message": "...", "suggestions": [...] }
```

---

## 4. Import from Zenodo

First search for a record that has `.dcm` files (`importable: true`), then import.

**Import files from a record:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": 1234567,
    "environment": "sandbox",
    "files": [
      { "fileKey": "scan_001.dcm", "fileSize": 2097152 },
      { "fileKey": "scan_002.dcm" }
    ],
    "overwrite_duplicates": false
  }'
```

Expected: `201` with import result including per-file statuses.

**Poll import job:**

```bash
curl http://localhost:3000/api/v1/zenodo/imports/1 \
  -H "Authorization: Bearer $TOKEN"
```

**Test duplicate handling:**

Run the same import twice without `overwrite_duplicates`. Second run should return `200` with `duplicates: N, imported: 0`.

**Test overwrite:**

```bash
curl -X POST http://localhost:3000/api/v1/zenodo/import \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ ...same body..., "overwrite_duplicates": true }'
# Expected: 201, files re-imported
```

**Test ZIP skip:**

Include a `.zip` file in the `files` array. Expected: `{ "status": "skipped" }` for that file.

**Test non-importable record:**

Use a record with only `.pdf` files. Expected: `422`.

---

## 5. Metadata sync

**Check current schedule:**

```bash
curl http://localhost:3000/api/v1/zenodo/config/sync \
  -H "Authorization: Bearer $TOKEN"
# Expected: { "interval_hours": 24, "last_run_at": null, "valid_intervals": [6,12,24,168] }
```

**Update the schedule:**

```bash
curl -X PUT http://localhost:3000/api/v1/zenodo/config/sync \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "interval_hours": 12 }'
# Expected: 200 with updated config

# Disable sync
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
curl "http://localhost:3000/api/v1/zenodo/quota?environment=production" \
  -H "Authorization: Bearer $TOKEN"
```

Expected:

```json
{
  "environment": "production",
  "used_bytes": 0,
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

**Trigger the quota alert** (for manual testing): temporarily set `ZENODO_QUOTA_LIMIT_GB=1` in your environment and publish a file larger than 0.9 GB.

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
