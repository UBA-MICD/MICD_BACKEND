# Database Schema

PostgreSQL 16. All migrations are idempotent (`CREATE/ALTER … IF [NOT] EXISTS`) and run in order on every server start via `src/db/migrate.ts`.

---

## Table: `studies`

One row per uploaded DICOM **instance** (file). Multiple rows share the same `orthanc_study_id` when a study contains more than one image/series.

| Column                         | Type          | Nullable                   | Description                                                                                                              |
| ------------------------------ | ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                           | `SERIAL`      | NOT NULL                   | Surrogate PK                                                                                                             |
| `orthanc_study_id`             | `TEXT`        | NOT NULL                   | Orthanc's internal study identifier (`ParentStudy` from `/instances` POST response)                                      |
| `orthanc_instance_id`          | `TEXT`        | NOT NULL                   | Orthanc's internal instance identifier (`ID` from `/instances` POST response)                                            |
| `sop_instance_uid`             | `TEXT`        | NOT NULL UNIQUE            | DICOM tag `0008,0018` — globally unique per file; conflict key for upsert                                                |
| `study_instance_uid`           | `TEXT`        | NULL                       | DICOM tag `0020,000D` — groups all instances of one study                                                                |
| `patient_name`                 | `TEXT`        | NULL                       | DICOM tag `0010,0010`                                                                                                    |
| `patient_id`                   | `TEXT`        | NULL                       | DICOM tag `0010,0020`                                                                                                    |
| `study_date`                   | `TEXT`        | NULL                       | DICOM tag `0008,0020` (format `YYYYMMDD`)                                                                                |
| `modality`                     | `TEXT`        | NULL                       | DICOM tag `0008,0060` uppercased; defaults to `OTHER` when absent                                                        |
| `study_description`            | `TEXT`        | NULL                       | DICOM tag `0008,1030` — study-level description                                                                          |
| `series_description`           | `TEXT`        | NULL                       | DICOM tag `0008,103E` — series-level description (added migration 012)                                                   |
| `number_of_images`             | `INTEGER`     | NULL                       | DICOM tag `0020,1208` — number of study-related images as reported by the modality (added migration 012)                 |
| `instance_number`              | `INTEGER`     | NULL                       | DICOM tag `0020,0013` — position of this instance within its series                                                      |
| `rows_count`                   | `INTEGER`     | NULL                       | DICOM tag `0028,0010` — image height in pixels                                                                           |
| `cols_count`                   | `INTEGER`     | NULL                       | DICOM tag `0028,0011` — image width in pixels                                                                            |
| `uploaded_at`                  | `TIMESTAMPTZ` | NOT NULL (default `NOW()`) | Server-side ingestion timestamp                                                                                          |
| `anonymized_at`                | `TIMESTAMPTZ` | NULL                       | Set when the study is anonymized via Orthanc; `IS NOT NULL` → anonymization status is "anonymized" (added migration 003) |
| `zenodo_doi`                   | `TEXT`        | NULL                       | Zenodo DOI after publication (added migration 003)                                                                       |
| `zenodo_published_at`          | `TIMESTAMPTZ` | NULL                       | Publication timestamp on Zenodo (added migration 003)                                                                    |
| `zenodo_source_record_id`      | `INTEGER`     | NULL                       | Source Zenodo record ID for imported studies (added migration 003)                                                       |
| `zenodo_source_doi`            | `TEXT`        | NULL                       | Source DOI for imported studies (added migration 003)                                                                    |
| `zenodo_imported_at`           | `TIMESTAMPTZ` | NULL                       | Import timestamp (added migration 003)                                                                                   |
| `zenodo_version`               | `TEXT`        | NULL                       | Zenodo version string (added migration 005)                                                                              |
| `zenodo_concept_record_id`     | `INTEGER`     | NULL                       | Zenodo concept record ID for versioning (added migration 005)                                                            |
| `zenodo_new_version_available` | `BOOLEAN`     | NULL                       | Set when a newer Zenodo version was detected (added migration 005)                                                       |

### Indexes on `studies`

| Index                            | Type          | Column(s)            | Purpose                                                           |
| -------------------------------- | ------------- | -------------------- | ----------------------------------------------------------------- |
| `idx_studies_orthanc_study_id`   | B-tree        | `orthanc_study_id`   | JOIN / lookup by Orthanc study ID                                 |
| `idx_studies_modality`           | B-tree        | `modality`           | Filter by modality                                                |
| `idx_studies_study_date`         | B-tree        | `study_date`         | Filter / sort by date                                             |
| `idx_studies_patient_name_trgm`  | GIN (pg_trgm) | `patient_name`       | Full-text ILIKE search                                            |
| `idx_studies_patient_id_trgm`    | GIN (pg_trgm) | `patient_id`         | Full-text ILIKE search                                            |
| `idx_studies_study_instance_uid` | B-tree        | `study_instance_uid` | Query by DICOM StudyInstanceUID in < 500 ms (added migration 012) |

### Duplication behaviour

Uploads use `INSERT … ON CONFLICT (sop_instance_uid) DO UPDATE`, so re-uploading the same DICOM file updates its metadata row rather than inserting a duplicate. Uploading additional files from the same _study_ (different SOP UIDs) creates additional rows that share `orthanc_study_id`.

---

## Table: `users`

| Column          | Type          | Nullable                    | Description                 |
| --------------- | ------------- | --------------------------- | --------------------------- |
| `id`            | `SERIAL`      | NOT NULL                    | Surrogate PK                |
| `email`         | `TEXT`        | NOT NULL UNIQUE             | Login identifier            |
| `password`      | `TEXT`        | NOT NULL                    | bcrypt hash                 |
| `role`          | `TEXT`        | NOT NULL (default `medico`) | `admin` or `medico`         |
| `status`        | `TEXT`        | NOT NULL (default `active`) | `active` or `inactive`      |
| `name`          | `TEXT`        | NULL                        | Display name                |
| `last_login_at` | `TIMESTAMPTZ` | NULL                        | Updated on successful login |

Migration: 002, 006.

---

## Table: `refresh_tokens`

| Column       | Type          | Nullable                   | Description                      |
| ------------ | ------------- | -------------------------- | -------------------------------- |
| `id`         | `SERIAL`      | NOT NULL                   | Surrogate PK                     |
| `user_id`    | `INTEGER`     | NOT NULL → `users(id)`     | Token owner                      |
| `token_hash` | `TEXT`        | NOT NULL UNIQUE            | SHA-256 of the raw refresh token |
| `expires_at` | `TIMESTAMPTZ` | NOT NULL                   | Expiry (7 days from issue)       |
| `created_at` | `TIMESTAMPTZ` | NOT NULL (default `NOW()`) | Issue timestamp                  |

Tokens are **rotated** on every `/auth/refresh` — the old row is atomically replaced to prevent reuse races. Migration: 002.

---

## Table: `audit_log`

Append-only log of privileged actions. `DELETE` and `UPDATE` are blocked by a trigger (migration 008).

| Column        | Type          | Nullable                   | Description                                             |
| ------------- | ------------- | -------------------------- | ------------------------------------------------------- |
| `id`          | `SERIAL`      | NOT NULL                   | Surrogate PK                                            |
| `user_id`     | `INTEGER`     | NULL → `users(id)`         | Actor (NULL for system events)                          |
| `action`      | `TEXT`        | NOT NULL                   | Action code (see `src/shared/audit.ts` `AUDIT_ACTIONS`) |
| `resource_id` | `TEXT`        | NULL                       | Affected resource identifier (e.g. `orthanc_study_id`)  |
| `timestamp`   | `TIMESTAMPTZ` | NOT NULL (default `NOW()`) | Event time                                              |
| `ip`          | `TEXT`        | NULL                       | Client IP                                               |
| `detail`      | `JSONB`       | NULL                       | Structured extra context                                |

Migration: 004, 008.

---

## Table: `study_validations`

Immutable validation records. Corrections reference the row they correct via `corrects_id`.

| Column        | Type          | Nullable                       | Description                               |
| ------------- | ------------- | ------------------------------ | ----------------------------------------- |
| `id`          | `SERIAL`      | NOT NULL                       | Surrogate PK                              |
| `study_id`    | `TEXT`        | NOT NULL                       | `orthanc_study_id` of the validated study |
| `action`      | `TEXT`        | NOT NULL                       | `approved`, `rejected`, or `review`       |
| `comment`     | `TEXT`        | NULL                           | Optional reviewer comment                 |
| `user_id`     | `INTEGER`     | NOT NULL → `users(id)`         | Reviewer                                  |
| `created_at`  | `TIMESTAMPTZ` | NOT NULL (default `NOW()`)     | Validation timestamp                      |
| `corrects_id` | `INTEGER`     | NULL → `study_validations(id)` | Points to the row this record corrects    |

Index: `idx_study_validations_study_id` on `study_id`. Migration: 010.

---

## Table: `study_ml_predictions`

Stores ML inference results. The latest row by `analyzed_at` is the canonical prediction.

| Column        | Type          | Nullable                   | Description                              |
| ------------- | ------------- | -------------------------- | ---------------------------------------- |
| `id`          | `SERIAL`      | NOT NULL                   | Surrogate PK                             |
| `study_id`    | `TEXT`        | NOT NULL                   | `orthanc_study_id` of the analysed study |
| `label`       | `TEXT`        | NOT NULL                   | Model output label (e.g. `normal`)       |
| `confidence`  | `FLOAT`       | NOT NULL                   | Confidence score 0–1                     |
| `analyzed_by` | `INTEGER`     | NOT NULL → `users(id)`     | Admin who triggered the analysis         |
| `analyzed_at` | `TIMESTAMPTZ` | NOT NULL (default `NOW()`) | Analysis timestamp                       |

Index: `idx_study_ml_predictions_study_id` on `study_id`. Migration: 011.
