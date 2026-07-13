# Zenodo Integration

All Zenodo endpoints live under `/api/v1/zenodo`. Routes that modify state require a valid JWT (`Authorization: Bearer <token>`). Routes marked **admin** additionally require `role = 'admin'`.

Environments: `sandbox` (sandbox.zenodo.org) and `production` (zenodo.org). Pass `environment` in the request body or query string; defaults to `production` where applicable.

---

## Credential management

Store or replace an API token for a Zenodo environment.

```
POST   /api/v1/zenodo/config          — store token (admin)
DELETE /api/v1/zenodo/config/:env     — remove token (admin)
GET    /api/v1/zenodo/config/status   — connectivity status for all environments (admin)
```

The token is AES-256-GCM encrypted before being written to `zenodo_config`. The API only exposes a `token_hint` (last 4 characters) for display.

**Health** is checked at startup and every hour via cron. Status values: `connected`, `error`, `unconfigured`.

---

## Publish anonymized study

Upload all DICOM instances of an Orthanc study to Zenodo and publish a dataset with a DOI.

```
POST /api/v1/zenodo/publish                         — start publish job (auth required)
GET  /api/v1/zenodo/depositions/:depositionId       — poll status
POST /api/v1/zenodo/depositions/:depositionId/retry — retry failed file uploads
```

**Prerequisites**: every instance in the study must have `anonymized_at` set (populated by US-16).

**Size limit**: if the total file size exceeds 50 GB, the request is rejected with HTTP 413. Send `"force_large_upload": true` to override.

Request body for `POST /publish`:

```json
{
  "orthanc_study_id": "...",
  "environment": "sandbox",
  "title": "Lung CT Dataset",
  "description": "...",
  "authors": [{ "name": "Doe, Jane", "affiliation": "UBA", "orcid": "0000-..." }],
  "license": "cc-by-4.0",
  "keywords": ["CT", "DICOM"],
  "force_large_upload": false
}
```

On success (HTTP 201):

```json
{
  "deposition_id": 42,
  "doi": "10.5281/zenodo.12345",
  "files_uploaded": 3,
  "total_bytes": 1073741824
}
```

Error codes: `study_not_found` (404), `not_anonymized` (422), `no_credentials` (422), `file_too_large` (413), `upload_failed` (400), `publish_rejected` (400).

---

## Search Zenodo records

Search the public Zenodo catalogue. No authentication required.

```
GET /api/v1/zenodo/search
GET /api/v1/zenodo/records/:recordId
```

Query parameters for `/search`:

| Param | Description |
|---|---|
| `q` | Free-text query |
| `environment` | `sandbox` or `production` (default `production`) |
| `page` | Page number (default 1) |
| `size` | Results per page, max 100 (default 20) |
| `file_type` | Filter by extension, e.g. `dcm` |
| `license` | License ID, e.g. `cc-by-4.0` |
| `date_from` / `date_to` | ISO date range for `publication_date` |
| `keywords` | Additional keyword terms appended to the query |

Each record in the response includes `importable: true/false` indicating whether it contains `.dcm` or `.zip` files.

---

## Import from Zenodo

Download DICOM files from a Zenodo record directly into Orthanc and register them in the DB.

```
POST /api/v1/zenodo/import               — start import job (auth required)
GET  /api/v1/zenodo/imports/:importId    — poll status
```

Request body:

```json
{
  "record_id": 1234567,
  "environment": "production",
  "files": [
    { "fileKey": "scan_001.dcm", "fileSize": 2097152 },
    { "fileKey": "scan_002.dcm" }
  ],
  "overwrite_duplicates": false
}
```

Files are streamed directly from Zenodo to Orthanc — nothing is buffered in memory. `.zip` files are skipped with `status: "skipped"`.

Response status codes: 201 if at least one file was imported, 200 if all were duplicates, 422 if all failed or no eligible files.

Imported studies get `zenodo_source_record_id`, `zenodo_source_doi`, `zenodo_imported_at`, `zenodo_version`, and `zenodo_concept_record_id` populated.

---

## Metadata sync

Periodically check whether imported Zenodo records have a newer version available and flag the corresponding studies.

```
GET  /api/v1/zenodo/config/sync          — get schedule config (admin)
PUT  /api/v1/zenodo/config/sync          — set interval (admin)
POST /api/v1/zenodo/config/sync/run      — trigger immediately (admin)
GET  /api/v1/zenodo/config/sync/logs     — past run log (admin)
```

Valid `interval_hours` values: `6`, `12`, `24` (default), `168`. Send `null` to disable automatic sync; manual triggers still work.

A cron fires every 30 minutes and calls `shouldRunSync()` to decide whether to act. When a new version is found, `zenodo_new_version_available = TRUE` is set on every row sharing that `zenodo_source_record_id`. The field is surfaced in `GET /api/v1/studies` as a per-study `BOOL_OR`.

---

## Quota and rate limiting

### Rate limiting

Every Zenodo API call goes through a shared sliding-window counter stored in `zenodo_api_requests`. When 50 requests have been made in the last 60 seconds, the next call waits until the window clears before proceeding. File uploads/downloads are excluded (they go to S3/CDN, not the API).

### Storage quota

Zenodo does not expose total usage via API. Usage is estimated from locally recorded file sizes in `zenodo_deposition_files`. An alert fires at 90% of the configured limit.

```
GET /api/v1/zenodo/quota?environment=production   — (admin)
```

Response:

```json
{
  "environment": "production",
  "used_bytes": 45097156608,
  "limit_bytes": 53687091200,
  "percent_used": 84.0,
  "alert": false,
  "alert_message": null,
  "rate_limit": {
    "requests_last_minute": 3,
    "throttle_at": 50,
    "limit": 60
  }
}
```

Configure the storage limit with `ZENODO_QUOTA_LIMIT_GB` (default `50`).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ZENODO_QUOTA_LIMIT_GB` | `50` | Storage limit for quota alerts (GB) |
| `ZENODO_TIMEOUT_MS` | `10000` | Timeout for Zenodo API calls (ms) |
| `ZENODO_UPLOAD_TIMEOUT_MS` | `300000` | Timeout for file transfers (ms) |

---

## DB tables (Zenodo-specific)

| Table | Purpose |
|---|---|
| `zenodo_config` | Encrypted token per environment |
| `zenodo_health` | Last connectivity status per environment |
| `zenodo_depositions` | One row per publish attempt |
| `zenodo_deposition_files` | Per-file upload status within a deposition |
| `zenodo_imports` | One row per import job |
| `zenodo_import_files` | Per-file status within an import job |
| `zenodo_sync_config` | Singleton: sync schedule config |
| `zenodo_sync_log` | Log of each sync run |
| `zenodo_api_requests` | Sliding-window rate limit counter |
