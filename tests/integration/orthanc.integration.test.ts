/**
 * Integration tests against a live Orthanc instance.
 *
 * Requires ORTHANC_URL (default http://localhost:8042) to be reachable.
 * Run after `docker compose up -d orthanc` or as part of the full stack.
 *
 * Usage:
 *   ORTHANC_URL=http://localhost:8042 npm test
 */
import fs from "fs";
import path from "path";
import axios from "axios";

const ORTHANC_URL = process.env.ORTHANC_URL ?? "http://localhost:8042";
const ORTHANC_USER = process.env.ORTHANC_USERNAME ?? "orthanc";
const ORTHANC_PASS = process.env.ORTHANC_PASSWORD ?? "orthanc";

const client = axios.create({
  baseURL: ORTHANC_URL,
  auth: { username: ORTHANC_USER, password: ORTHANC_PASS },
});

const SAMPLE_DICOM = path.resolve(
  __dirname,
  "../../.data.example/series-000001/image-000001.dcm",
);

// Skip all tests if Orthanc is not reachable
let orthancAvailable = false;

beforeAll(async () => {
  try {
    await client.get("/system", { timeout: 3000 });
    orthancAvailable = true;
  } catch {
    console.warn("Orthanc not reachable — skipping integration tests");
  }
});

describe("Orthanc integration", () => {
  let uploadedInstanceId: string;
  let uploadedStudyId: string;

  it("GET /system returns server info", async () => {
    if (!orthancAvailable) return;
    const { data } = await client.get("/system");
    expect(data).toHaveProperty("Version");
    expect(data).toHaveProperty("DicomAet");
  });

  it("GET /studies returns an array (initially empty)", async () => {
    if (!orthancAvailable) return;
    const { data } = await client.get("/studies");
    expect(Array.isArray(data)).toBe(true);
  });

  it("rejects unauthenticated requests with 401", async () => {
    if (!orthancAvailable) return;
    await expect(axios.get(`${ORTHANC_URL}/studies`)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it("POST /instances uploads a DICOM file and returns study ID", async () => {
    if (!orthancAvailable) return;
    const dicomBuffer = fs.readFileSync(SAMPLE_DICOM);
    const { data, status } = await client.post("/instances", dicomBuffer, {
      headers: { "Content-Type": "application/dicom" },
      maxBodyLength: Infinity,
    });
    expect(status).toBe(200);
    expect(data).toHaveProperty("ID");
    expect(data).toHaveProperty("ParentStudy");
    uploadedInstanceId = data.ID;
    uploadedStudyId = data.ParentStudy;
  });

  it("GET /studies/:id retrieves the uploaded study with metadata", async () => {
    if (!orthancAvailable || !uploadedStudyId) return;
    const { data } = await client.get(`/studies/${uploadedStudyId}`);
    expect(data).toHaveProperty("ID", uploadedStudyId);
    expect(data).toHaveProperty("MainDicomTags");
    expect(data.MainDicomTags).toHaveProperty("StudyDate");
  });

  it("GET /instances/:id/tags returns DICOM tags for the instance", async () => {
    if (!orthancAvailable || !uploadedInstanceId) return;
    const { data } = await client.get(`/instances/${uploadedInstanceId}/tags`);
    // SOPInstanceUID must be present
    expect(data).toHaveProperty("0008,0018");
  });

  it("DELETE /studies/:id removes the study", async () => {
    if (!orthancAvailable || !uploadedStudyId) return;
    const { status } = await client.delete(`/studies/${uploadedStudyId}`);
    expect(status).toBe(200);

    await expect(
      client.get(`/studies/${uploadedStudyId}`),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });
});
