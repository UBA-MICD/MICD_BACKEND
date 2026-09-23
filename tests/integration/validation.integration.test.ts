/**
 * Integration tests for diagnostic validation endpoints (US-26):
 *   POST /api/v1/studies/:studyId/validate
 *   POST /api/v1/studies/:studyId/validation-correction
 *
 * Requires a running backend + DB + at least one study in the studies table.
 * Run: npm run test:integration
 */
import axios, { AxiosError } from "axios";
import { getAuthHeaderFor } from "../helpers/auth";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

let backendAvailable = false;
let staffHeader: { Authorization: string };
let adminHeader: { Authorization: string };
let investigadorHeader: { Authorization: string };
let existingStudyId: string | null = null;

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;

    [staffHeader, adminHeader, investigadorHeader] = await Promise.all([
      getAuthHeaderFor("medico"),
      getAuthHeaderFor("admin"),
      getAuthHeaderFor("investigador"),
    ]);

    // Pick any study to validate
    const { data } = await axios.get(`${BASE_URL}/api/v1/studies?limit=1`, {
      headers: staffHeader,
    });
    existingStudyId = data.studies[0]?.orthanc_study_id ?? null;
  } catch {
    console.warn(
      "Backend not reachable — skipping validation integration tests",
    );
  }
});

// ── POST /validate ────────────────────────────────────────────────────────────

describe("POST /api/v1/studies/:studyId/validate", () => {
  it("201 — medico can approve a study", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status, data } = await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
      { action: "approved" },
      { headers: staffHeader },
    );
    expect(status).toBe(201);
    expect(data).toMatchObject({
      validationId: expect.any(Number),
      status: "approved",
      validatedBy: expect.any(String),
      validatedAt: expect.any(String),
    });
  });

  it("201 — medico can reject with a comment", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status, data } = await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
      { action: "rejected", comment: "Imagen borrosa" },
      { headers: staffHeader },
    );
    expect(status).toBe(201);
    expect(data.status).toBe("rejected");
  });

  it("201 — medico can flag for review without a comment", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status, data } = await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
      { action: "review" },
      { headers: staffHeader },
    );
    expect(status).toBe(201);
    expect(data.status).toBe("review");
  });

  it("201 — rejected without comment is accepted (the comment is optional)", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status, data } = await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
      { action: "rejected" },
      { headers: staffHeader },
    );
    expect(status).toBe(201);
    expect(data.status).toBe("rejected");
  });

  it("400 — missing action returns 400", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
        { comment: "sin action" },
        { headers: staffHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it("400 — invalid action value returns 400", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
        { action: "invalid" },
        { headers: staffHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it("403 — investigador cannot validate", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
        { action: "approved" },
        { headers: investigadorHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it("401 — unauthenticated request is rejected", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.post(`${BASE_URL}/api/v1/studies/${existingStudyId}/validate`, {
        action: "approved",
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("404 — non-existent study returns 404", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/studies/nonexistent-study-id/validate`,
        { action: "approved" },
        { headers: staffHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("studies list includes validation_status after a validation", async () => {
    if (!backendAvailable || !existingStudyId) return;
    // Approve the study
    await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
      { action: "approved" },
      { headers: staffHeader },
    );
    const { data } = await axios.get(`${BASE_URL}/api/v1/studies?limit=100`, {
      headers: staffHeader,
    });
    const study = data.studies.find(
      (s: { orthanc_study_id: string }) =>
        s.orthanc_study_id === existingStudyId,
    );
    expect(study).toBeDefined();
    expect(study.validation_status).toBe("approved");
    expect(study.validated_by).toBeDefined();
    expect(study.validated_at).toBeDefined();
  });
});

// ── POST /validation-correction ───────────────────────────────────────────────

describe("POST /api/v1/studies/:studyId/validation-correction", () => {
  beforeAll(async () => {
    // Ensure at least one validation exists for correction tests
    if (!backendAvailable || !existingStudyId) return;
    await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
      { action: "approved" },
      { headers: adminHeader },
    );
  });

  it("201 — admin can record a correction", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status, data } = await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validation-correction`,
      { action: "rejected", comment: "Error en la validación previa" },
      { headers: adminHeader },
    );
    expect(status).toBe(201);
    expect(data).toMatchObject({
      validationId: expect.any(Number),
      status: "rejected",
    });
  });

  it("403 — medico cannot correct a validation", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/studies/${existingStudyId}/validation-correction`,
        { action: "approved" },
        { headers: staffHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it("403 — investigador cannot correct a validation", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/studies/${existingStudyId}/validation-correction`,
        { action: "approved" },
        { headers: investigadorHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it("401 — unauthenticated request is rejected", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/studies/${existingStudyId}/validation-correction`,
        { action: "approved" },
      ),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("201 — a correction to rejected without comment is accepted", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status } = await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validation-correction`,
      { action: "rejected" },
      { headers: adminHeader },
    );
    expect(status).toBe(201);
  });
});

// ── GET /api/v1/studies?validation_status= ────────────────────────────────────

describe("GET /api/v1/studies?validation_status filter", () => {
  beforeAll(async () => {
    // Ensure the study has a known validation state (approved) before running filter tests
    if (!backendAvailable || !existingStudyId) return;
    await axios.post(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validate`,
      { action: "approved" },
      { headers: staffHeader },
    );
  });

  it("200 — returns only approved studies when validation_status=approved", async () => {
    if (!backendAvailable) return;
    const { status, data } = await axios.get(
      `${BASE_URL}/api/v1/studies?validation_status=approved&limit=50`,
      { headers: staffHeader },
    );
    expect(status).toBe(200);
    expect(Array.isArray(data.studies)).toBe(true);
    for (const study of data.studies) {
      expect(study.validation_status).toBe("approved");
    }
  });

  it("200 — approved study does NOT appear in validation_status=none results", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?validation_status=none&limit=100`,
      { headers: staffHeader },
    );
    const found = data.studies.some(
      (s: { orthanc_study_id: string }) =>
        s.orthanc_study_id === existingStudyId,
    );
    expect(found).toBe(false);
  });

  it("200 — approved study appears in validation_status=approved results", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?validation_status=approved&limit=100`,
      { headers: staffHeader },
    );
    const found = data.studies.some(
      (s: { orthanc_study_id: string }) =>
        s.orthanc_study_id === existingStudyId,
    );
    expect(found).toBe(true);
  });

  it("200 — no validation_status filter returns all studies", async () => {
    if (!backendAvailable) return;
    const [all, approved] = await Promise.all([
      axios.get(`${BASE_URL}/api/v1/studies?limit=100`, {
        headers: staffHeader,
      }),
      axios.get(
        `${BASE_URL}/api/v1/studies?validation_status=approved&limit=100`,
        {
          headers: staffHeader,
        },
      ),
    ]);
    expect(all.data.total).toBeGreaterThanOrEqual(approved.data.total);
  });

  it("400 — invalid validation_status value returns 400", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.get(`${BASE_URL}/api/v1/studies?validation_status=invalid`, {
        headers: staffHeader,
      }),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});

// ── GET /validation — role access ─────────────────────────────────────────────

describe("GET /api/v1/studies/:studyId/validation — role access", () => {
  it("200 — investigador can read the validation status (read is open to all roles)", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status, data } = await axios.get(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validation`,
      { headers: investigadorHeader },
    );
    expect(status).toBe(200);
    // May be null or a record — both are valid
    expect(data === null || typeof data === "object").toBe(true);
  });

  it("200 — medico can read the validation status", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status } = await axios.get(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validation`,
      { headers: staffHeader },
    );
    expect(status).toBe(200);
  });

  it("200 — admin can read the validation status", async () => {
    if (!backendAvailable || !existingStudyId) return;
    const { status } = await axios.get(
      `${BASE_URL}/api/v1/studies/${existingStudyId}/validation`,
      { headers: adminHeader },
    );
    expect(status).toBe(200);
  });

  it("401 — unauthenticated request is rejected", async () => {
    if (!backendAvailable || !existingStudyId) return;
    await expect(
      axios.get(`${BASE_URL}/api/v1/studies/${existingStudyId}/validation`),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});
