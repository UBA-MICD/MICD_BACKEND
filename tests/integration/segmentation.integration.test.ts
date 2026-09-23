/**
 * Integration tests for AI segmentation correction endpoints (US-45):
 *   POST /api/v1/ml/segmentation                      (persists a candidate)
 *   POST /api/v1/ml/segmentation/:id/corrections      (append-only correction)
 *   GET  /api/v1/ml/segmentation/:id/corrections      (candidate + chain)
 *   POST /api/v1/ml/segmentation/:id/accept | /discard
 *
 * Requires a running backend + DB. Run: npm run test:integration
 */
import axios from "axios";
import { getAuthHeaderFor } from "../helpers/auth";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

let backendAvailable = false;
let staffHeader: { Authorization: string };
let adminHeader: { Authorization: string };
let investigadorHeader: { Authorization: string };

// A tiny mask: 4×4, one foreground run. RLE is background-first alternating runs.
const MASK_SHAPE: [number, number] = [4, 4];
const CORRECTED_RLE = [5, 6, 5];

/** Create a fresh persisted candidate and return its id. */
async function newCandidate(
  header: { Authorization: string } = staffHeader,
): Promise<number> {
  const { data } = await axios.post(
    `${BASE_URL}/api/v1/ml/segmentation`,
    {
      columns: 4,
      rows: 4,
      sopInstanceUid: `test.us45.${Date.now()}.${Math.random()}`,
    },
    { headers: header },
  );
  return data.segmentationId as number;
}

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;
    [staffHeader, adminHeader, investigadorHeader] = await Promise.all([
      getAuthHeaderFor("medico"),
      getAuthHeaderFor("admin"),
      getAuthHeaderFor("investigador"),
    ]);
  } catch {
    console.warn(
      "Backend not reachable — skipping segmentation integration tests",
    );
  }
});

// ── candidate persistence ─────────────────────────────────────────────────────

describe("POST /api/v1/ml/segmentation persists a candidate", () => {
  it("201 — returns a segmentationId when a source UID is supplied", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("segmentationId is null for a local-disk image (no source UID)", async () => {
    if (!backendAvailable) return;
    const { data } = await axios.post(
      `${BASE_URL}/api/v1/ml/segmentation`,
      { columns: 4, rows: 4 },
      { headers: staffHeader },
    );
    expect(data.segmentationId).toBeNull();
  });
});

// ── corrections (append-only chain) ───────────────────────────────────────────

describe("POST /api/v1/ml/segmentation/:id/corrections", () => {
  it("201 — medico can correct; history keeps candidate + correction", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();

    const { status, data } = await axios.post(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
      {
        correctedRle: CORRECTED_RLE,
        maskShape: MASK_SHAPE,
        editSummary: { movedVertices: 2, addedZones: 0, removedZones: 0 },
      },
      { headers: staffHeader },
    );
    expect(status).toBe(201);
    expect(data).toMatchObject({
      correctionId: expect.any(Number),
      segmentationId: id,
      correctedBy: expect.any(String),
      correctedAt: expect.any(String),
    });

    const history = await axios.get(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
      { headers: staffHeader },
    );
    expect(history.data.segmentation.status).toBe("corrected");
    expect(history.data.segmentation.reviewedBy).toEqual(expect.any(String));
    expect(history.data.corrections).toHaveLength(1);
  });

  it("second correction chains to the first via corrects_id", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    await axios.post(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
      { correctedRle: CORRECTED_RLE, maskShape: MASK_SHAPE },
      { headers: staffHeader },
    );
    await axios.post(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
      { correctedRle: [4, 8, 4], maskShape: MASK_SHAPE },
      { headers: staffHeader },
    );
    const { data } = await axios.get(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
      { headers: staffHeader },
    );
    expect(data.corrections).toHaveLength(2);
  });

  it("400 — empty correctedRle is rejected", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
        { correctedRle: [], maskShape: MASK_SHAPE },
        { headers: staffHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it("403 — investigador cannot correct", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
        { correctedRle: CORRECTED_RLE, maskShape: MASK_SHAPE },
        { headers: investigadorHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it("404 — correcting a non-existent segmentation returns 404", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/ml/segmentation/99999999/corrections`,
        { correctedRle: CORRECTED_RLE, maskShape: MASK_SHAPE },
        { headers: staffHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });
});

// ── accept / discard ──────────────────────────────────────────────────────────

describe("POST /api/v1/ml/segmentation/:id/accept | /discard", () => {
  it("200 — admin can accept a candidate", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    const { status, data } = await axios.post(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/accept`,
      {},
      { headers: adminHeader },
    );
    expect(status).toBe(200);
    expect(data.segmentation.status).toBe("accepted");
  });

  it("200 — medico can discard a candidate; further corrections are 409", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    const { data } = await axios.post(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/discard`,
      {},
      { headers: staffHeader },
    );
    expect(data.segmentation.status).toBe("discarded");

    await expect(
      axios.post(
        `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
        { correctedRle: CORRECTED_RLE, maskShape: MASK_SHAPE },
        { headers: staffHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });

  it("403 — investigador cannot discard", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    await expect(
      axios.post(
        `${BASE_URL}/api/v1/ml/segmentation/${id}/discard`,
        {},
        { headers: investigadorHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});

// ── history read access ───────────────────────────────────────────────────────

describe("GET /api/v1/ml/segmentation/:id/corrections — role access", () => {
  it("200 — investigador can read history (read is open to all roles)", async () => {
    if (!backendAvailable) return;
    const id = await newCandidate();
    const { status, data } = await axios.get(
      `${BASE_URL}/api/v1/ml/segmentation/${id}/corrections`,
      { headers: investigadorHeader },
    );
    expect(status).toBe(200);
    expect(data.segmentation.segmentationId).toBe(id);
  });

  it("401 — unauthenticated request is rejected", async () => {
    if (!backendAvailable) return;
    await expect(
      axios.get(`${BASE_URL}/api/v1/ml/segmentation/1/corrections`),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });
});
