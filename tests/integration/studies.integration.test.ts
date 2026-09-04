/**
 * Integration tests for GET /api/v1/studies (paginated, filtered)
 * Requires the backend + DB to be running.
 * Run: npm run test:integration
 */
import axios from "axios";
import { getAuthHeader } from "../helpers/auth";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

let backendAvailable = false;
let authHeader: { Authorization: string } = { Authorization: "" };

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;
    authHeader = await getAuthHeader();
  } catch {
    console.warn("Backend not reachable — skipping studies integration tests");
  }
});

describe("GET /api/v1/studies", () => {
  it("returns paginated envelope with default page=1 limit=20", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: authHeader,
    });
    expect(data).toMatchObject({
      page: 1,
      limit: 20,
    });
    expect(typeof data.total).toBe("number");
    expect(typeof data.totalPages).toBe("number");
    expect(Array.isArray(data.studies)).toBe(true);
    expect(data.studies.length).toBeLessThanOrEqual(20);
  });

  it("returns num_instances per study", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: authHeader,
    });
    if (data.studies.length === 0) return;
    const s = data.studies[0];
    expect(s).toHaveProperty("num_instances");
    expect(Number(s.num_instances)).toBeGreaterThanOrEqual(1);
  });

  it("respects page and limit params", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?page=1&limit=2`,
      { headers: authHeader },
    );
    expect(data.page).toBe(1);
    expect(data.limit).toBe(2);
    expect(data.studies.length).toBeLessThanOrEqual(2);
  });

  it("clamps limit to max 100", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(`${BASE_URL}/api/v1/studies?limit=999`, {
      headers: authHeader,
    });
    expect(data.limit).toBe(100);
  });

  it("page 2 returns different studies than page 1 (when total > limit)", async () => {
    if (!backendAvailable) return;
    const p1 = await axios.get(`${BASE_URL}/api/v1/studies?page=1&limit=1`, {
      headers: authHeader,
    });
    if (p1.data.totalPages < 2) return;
    const p2 = await axios.get(`${BASE_URL}/api/v1/studies?page=2&limit=1`, {
      headers: authHeader,
    });
    expect(p1.data.studies[0].orthanc_study_id).not.toBe(
      p2.data.studies[0].orthanc_study_id,
    );
  });

  it("filters by modality", async () => {
    if (!backendAvailable) return;
    const allRes = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: authHeader,
    });
    if (allRes.data.studies.length === 0) return;

    const modality: string = allRes.data.studies[0].modality;
    if (!modality) return;

    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?modality=${encodeURIComponent(modality)}`,
      { headers: authHeader },
    );
    expect(Array.isArray(data.studies)).toBe(true);
    data.studies.forEach((s: any) => {
      expect(s.modality).toBe(modality);
    });
  });

  it("filters by date_from excludes older studies", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?date_from=99990101`,
      { headers: authHeader },
    );
    expect(data.total).toBe(0);
    expect(data.studies.length).toBe(0);
  });

  it("filters by date_to excludes future studies", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?date_to=19000101`,
      { headers: authHeader },
    );
    expect(data.total).toBe(0);
    expect(data.studies.length).toBe(0);
  });

  it("search by patient name returns matching studies", async () => {
    if (!backendAvailable) return;
    const allRes = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: authHeader,
    });
    if (allRes.data.studies.length === 0) return;

    const name: string = allRes.data.studies[0].patient_name ?? "";
    if (!name) return;

    const fragment = name.slice(0, 3);
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?search=${encodeURIComponent(fragment)}`,
      { headers: authHeader },
    );
    expect(Array.isArray(data.studies)).toBe(true);
    expect(data.studies.length).toBeGreaterThan(0);
    data.studies.forEach((s: any) => {
      const haystack =
        `${s.patient_name ?? ""} ${s.patient_id ?? ""}`.toLowerCase();
      expect(haystack).toContain(fragment.toLowerCase());
    });
  });

  it("search with no match returns empty list", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?search=XXXXXXXXXXX_NO_MATCH`,
      { headers: authHeader },
    );
    expect(data.total).toBe(0);
    expect(data.studies.length).toBe(0);
  });

  it("groups multiple instances of the same study into one row", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: authHeader,
    });
    const ids = data.studies.map((s: any) => s.orthanc_study_id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("filters by description returns only matching studies", async () => {
    if (!backendAvailable) return;
    const allRes = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: authHeader,
    });
    const withDesc = allRes.data.studies.find((s: any) => s.study_description);
    if (!withDesc) return;

    const fragment = (withDesc.study_description as string).slice(0, 4);
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?description=${encodeURIComponent(fragment)}`,
      { headers: authHeader },
    );
    expect(Array.isArray(data.studies)).toBe(true);
    expect(data.studies.length).toBeGreaterThan(0);
    data.studies.forEach((s: any) => {
      expect((s.study_description ?? "").toLowerCase()).toContain(
        fragment.toLowerCase(),
      );
    });
  });

  it("description filter with no match returns empty list, not 404", async () => {
    if (!backendAvailable) return;
    const { data, status } = await axios.get(
      `${BASE_URL}/api/v1/studies?description=XXXXXXXXXXX_NO_MATCH_DESCRIPTION`,
      { headers: authHeader },
    );
    expect(status).toBe(200);
    expect(data.total).toBe(0);
    expect(data.studies.length).toBe(0);
  });

  it("description filter combines with modality filter", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/studies?modality=CT&description=XXXXXXXXXXX_NO_MATCH_DESCRIPTION`,
      { headers: authHeader },
    );
    expect(data.total).toBe(0);
    expect(data.studies.length).toBe(0);
  });
});

describe("GET /api/v1/studies/:studyId/thumbnail", () => {
  it("returns 404 for unknown study", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.get(`${BASE_URL}/api/v1/studies/nonexistent-id/thumbnail`, {
        headers: authHeader,
      }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("returns image content for a valid study", async () => {
    if (!backendAvailable) return;
    const { data: list } = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: authHeader,
    });
    if (list.studies.length === 0) return;

    const studyId: string = list.studies[0].orthanc_study_id;
    try {
      const { headers, status } = await axios.get(
        `${BASE_URL}/api/v1/studies/${studyId}/thumbnail`,
        { headers: authHeader, responseType: "arraybuffer" },
      );
      expect(status).toBe(200);
      expect(headers["content-type"]).toMatch(/image\//);
    } catch (err: any) {
      // 503 acceptable if Orthanc preview not supported for this instance
      expect([200, 503]).toContain(err.response?.status);
    }
  });
});
