/**
 * openapi.ts — OpenAPI 3.0 specification for the MICD backend.
 *
 * Served by swagger-ui-express at /api/docs (interactive UI) and
 * /api/docs/openapi.json (raw spec). Kept as a plain object so it needs no
 * build step and stays in sync with the handlers in index.ts by review.
 */

const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
});

const unauthorized = errorResponse(
  "Missing, invalid or expired access token",
);

// Every route except /api/health and /auth/* is gated by requireAuth.
const bearerSecurity = [{ bearerAuth: [] }];

const studyIdParam = {
  name: "studyId",
  in: "path",
  required: true,
  description: "Orthanc study identifier",
  schema: { type: "string" },
};

const forceParam = {
  name: "force",
  in: "query",
  description: "Set to true to replace an existing instance",
  schema: { type: "boolean", default: false },
};

const uploadRequestBody = {
  required: true,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["file"],
        properties: {
          file: {
            type: "string",
            format: "binary",
            description: "DICOM file (max 500 MB)",
          },
        },
      },
    },
  },
};

const uploadResponses = {
  "201": {
    description: "Instance stored and indexed",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/UploadResult" },
      },
    },
  },
  "400": errorResponse("Missing or invalid DICOM file"),
  "401": unauthorized,
  "409": {
    description: "Instance already stored and force is not true",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/DuplicateError" },
      },
    },
  },
  "413": errorResponse("File exceeds the 500 MB limit"),
  "500": errorResponse("Failed to save metadata to database"),
  "503": errorResponse("Orthanc unavailable"),
};

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "MICD API",
    version: "1.0.0",
    description:
      "Backend for DICOM study management. Uploads are stored in Orthanc; " +
      "study metadata is indexed in PostgreSQL for listing, filtering and " +
      "ordered instance retrieval. All data routes require a JWT access " +
      "token obtained from POST /auth/login (Authorize button above).",
  },
  tags: [
    { name: "auth", description: "JWT login, token refresh and logout" },
    { name: "health", description: "Service health" },
    { name: "studies", description: "Studies indexed in PostgreSQL (v1)" },
    { name: "orthanc", description: "Thin proxy over the Orthanc REST API" },
    { name: "legacy", description: "Deprecated endpoints kept for the old app" },
  ],
  paths: {
    "/auth/login": {
      post: {
        tags: ["auth"],
        summary: "Log in with email and password",
        description:
          "Returns a short-lived access token (Bearer) and a rotating " +
          "refresh token. More than 5 failed attempts from the same IP " +
          "blocks that IP for 15 minutes.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Authenticated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginResponse" },
              },
            },
          },
          "400": errorResponse("email and password are required"),
          "401": errorResponse("Invalid email or password"),
          "429": errorResponse(
            "Too many failed login attempts from this IP — blocked for 15 minutes",
          ),
        },
      },
    },

    "/auth/refresh": {
      post: {
        tags: ["auth"],
        summary: "Exchange a refresh token for new tokens",
        description:
          "Rotates the refresh token: the presented token is revoked and a " +
          "new access/refresh pair is issued. A reused or expired token " +
          "returns 401.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["refreshToken"],
                properties: {
                  refreshToken: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "New token pair",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TokenPair" },
              },
            },
          },
          "400": errorResponse("refreshToken is required"),
          "401": errorResponse("Invalid, expired or already-used refresh token"),
        },
      },
    },

    "/auth/logout": {
      post: {
        tags: ["auth"],
        summary: "Log out",
        description:
          "Revokes the given refresh token. Always returns 204, even if the " +
          "token was missing or already revoked.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  refreshToken: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "204": { description: "Refresh token revoked (or was not valid)" },
        },
      },
    },

    "/api/health": {
      get: {
        tags: ["health"],
        summary: "Health check",
        description: "Verifies PostgreSQL and Orthanc connectivity.",
        responses: {
          "200": {
            description: "All dependencies reachable",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    orthanc: {
                      type: "string",
                      description: "Orthanc version",
                      example: "1.12.4",
                    },
                  },
                },
              },
            },
          },
          "503": {
            description: "PostgreSQL or Orthanc unreachable",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "degraded" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/v1/studies": {
      get: {
        tags: ["studies"],
        summary: "List studies (paginated, filterable)",
        description:
          "Studies from the PostgreSQL index, one row per study, newest " +
          "upload first.",
        security: bearerSecurity,
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", minimum: 1, default: 1 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: "modality",
            in: "query",
            description: "Exact DICOM modality, e.g. CT, MR, US",
            schema: { type: "string" },
          },
          {
            name: "date_from",
            in: "query",
            description: "Inclusive lower bound on StudyDate (YYYYMMDD)",
            schema: { type: "string", example: "20240101" },
          },
          {
            name: "date_to",
            in: "query",
            description: "Inclusive upper bound on StudyDate (YYYYMMDD)",
            schema: { type: "string", example: "20241231" },
          },
          {
            name: "search",
            in: "query",
            description:
              "Case-insensitive substring match on patient name or patient ID",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "One page of studies",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StudyPage" },
              },
            },
          },
          "401": unauthorized,
          "500": errorResponse("Database error"),
        },
      },
    },

    "/api/v1/studies/upload": {
      post: {
        tags: ["studies"],
        summary: "Upload a DICOM file",
        description:
          "Stores the file in Orthanc and indexes its metadata in " +
          "PostgreSQL. Re-uploading an already stored instance returns 409 " +
          "unless force=true.",
        security: bearerSecurity,
        parameters: [forceParam],
        requestBody: uploadRequestBody,
        responses: uploadResponses,
      },
    },

    "/api/v1/studies/{studyId}/instances": {
      get: {
        tags: ["studies"],
        summary: "List a study's instances in viewing order",
        description:
          "Ordered by DICOM InstanceNumber ascending; instances without one " +
          "go last in upload order.",
        security: bearerSecurity,
        parameters: [studyIdParam],
        responses: {
          "200": {
            description: "Ordered instance list",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/InstancesPayload" },
              },
            },
          },
          "401": unauthorized,
          "404": errorResponse("Study not found"),
          "500": errorResponse("Database error"),
        },
      },
    },

    "/api/v1/studies/{studyId}/file": {
      get: {
        tags: ["studies"],
        summary: "Download the study's first DICOM instance",
        security: bearerSecurity,
        parameters: [studyIdParam],
        responses: {
          "200": {
            description: "DICOM file",
            content: {
              "application/dicom": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "401": unauthorized,
          "404": errorResponse("Study or instance not found"),
          "503": errorResponse("Orthanc unavailable"),
        },
      },
    },

    "/api/v1/studies/{studyId}/instances/{instanceId}/file": {
      get: {
        tags: ["studies"],
        summary: "Download a specific DICOM instance",
        security: bearerSecurity,
        parameters: [
          studyIdParam,
          {
            name: "instanceId",
            in: "path",
            required: true,
            description: "Orthanc instance identifier",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "DICOM file",
            content: {
              "application/dicom": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "401": unauthorized,
          "404": errorResponse("Instance not found"),
          "503": errorResponse("Orthanc unavailable"),
        },
      },
    },

    "/api/v1/studies/{studyId}/thumbnail": {
      get: {
        tags: ["studies"],
        summary: "Preview image of the study's first instance",
        description: "Rendered by Orthanc; cached for one hour.",
        security: bearerSecurity,
        parameters: [studyIdParam],
        responses: {
          "200": {
            description: "Preview image",
            content: {
              "image/jpeg": { schema: { type: "string", format: "binary" } },
              "image/png": { schema: { type: "string", format: "binary" } },
            },
          },
          "401": unauthorized,
          "404": errorResponse("Study or instance not found"),
          "422": errorResponse(
            "Preview not available for this DICOM type (e.g. RT-STRUCT, SR)",
          ),
          "503": errorResponse("Orthanc unavailable"),
        },
      },
    },

    "/api/studies": {
      get: {
        tags: ["orthanc"],
        summary: "List Orthanc study IDs",
        security: bearerSecurity,
        responses: {
          "200": {
            description: "Array of Orthanc study identifiers",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "string" } },
              },
            },
          },
          "401": unauthorized,
          "503": errorResponse("Orthanc unavailable"),
        },
      },
    },

    "/api/studies/{id}": {
      get: {
        tags: ["orthanc"],
        summary: "Get an Orthanc study",
        security: bearerSecurity,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Orthanc study identifier",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Orthanc study resource (shape defined by Orthanc)",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "401": unauthorized,
          "404": errorResponse("Study not found"),
          "503": errorResponse("Orthanc unavailable"),
        },
      },
      delete: {
        tags: ["orthanc"],
        summary: "Delete a study from Orthanc",
        description:
          "Removes the study from Orthanc only; the PostgreSQL index is not " +
          "touched.",
        security: bearerSecurity,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Orthanc study identifier",
            schema: { type: "string" },
          },
        ],
        responses: {
          "204": { description: "Deleted" },
          "401": unauthorized,
          "404": errorResponse("Study not found"),
          "503": errorResponse("Orthanc unavailable"),
        },
      },
    },

    "/api/instances": {
      post: {
        tags: ["legacy"],
        summary: "Upload a DICOM file (legacy)",
        description:
          "Deprecated alias of POST /api/v1/studies/upload kept for the old " +
          "app; identical behavior and responses.",
        deprecated: true,
        security: bearerSecurity,
        parameters: [forceParam],
        requestBody: uploadRequestBody,
        responses: uploadResponses,
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Access token from POST /auth/login (15 min lifetime; renew via " +
          "POST /auth/refresh)",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          detail: { type: "string" },
        },
      },
      AuthUser: {
        type: "object",
        properties: {
          id: { type: "integer" },
          email: { type: "string", format: "email" },
          role: { type: "string", example: "admin" },
        },
      },
      TokenPair: {
        type: "object",
        properties: {
          accessToken: {
            type: "string",
            description: "JWT for the Authorization: Bearer header (15 min)",
          },
          refreshToken: {
            type: "string",
            description: "Rotating refresh token (7 days, single use)",
          },
        },
      },
      LoginResponse: {
        allOf: [
          { $ref: "#/components/schemas/TokenPair" },
          {
            type: "object",
            properties: {
              user: { $ref: "#/components/schemas/AuthUser" },
            },
          },
        ],
      },
      DuplicateError: {
        type: "object",
        properties: {
          error: { type: "string", example: "duplicate" },
          message: { type: "string" },
          sopInstanceUid: { type: "string" },
          existingStudyId: { type: "string" },
        },
      },
      Study: {
        type: "object",
        description:
          "One study aggregated from its instances in the PostgreSQL index",
        properties: {
          id: { type: "integer" },
          orthanc_study_id: { type: "string" },
          orthanc_instance_id: { type: "string" },
          patient_name: { type: "string" },
          patient_id: { type: "string" },
          study_date: { type: "string", example: "20240315" },
          modality: { type: "string", example: "CT" },
          study_description: { type: "string" },
          uploaded_at: { type: "string", format: "date-time" },
          num_instances: {
            type: "string",
            description: "Instance count (returned as string by COUNT(*))",
          },
        },
      },
      StudyPage: {
        type: "object",
        properties: {
          studies: {
            type: "array",
            items: { $ref: "#/components/schemas/Study" },
          },
          total: { type: "integer" },
          page: { type: "integer" },
          limit: { type: "integer" },
          totalPages: { type: "integer" },
        },
      },
      InstancesPayload: {
        type: "object",
        properties: {
          studyId: { type: "string" },
          count: { type: "integer" },
          instances: {
            type: "array",
            items: {
              type: "object",
              properties: {
                instanceId: { type: "string" },
                instanceNumber: { type: "integer", nullable: true },
              },
            },
          },
        },
      },
      UploadResult: {
        type: "object",
        properties: {
          study: {
            description: "Row persisted in the studies table",
            type: "object",
          },
          orthanc: {
            description: "Raw Orthanc upload response",
            type: "object",
            properties: {
              ID: { type: "string" },
              ParentStudy: { type: "string" },
              Status: { type: "string", example: "Success" },
            },
          },
        },
      },
    },
  },
};
