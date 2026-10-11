/**
 * Unit tests for runSegmentation (TK-44): fetch the DICOM from Orthanc, forward
 * it to the inference service, persist the candidate. Repo, Orthanc and the
 * inference client are mocked.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../../src/modules/segmentation/segmentation.repository");
jest.mock("../../../src/clients/orthanc.client", () => ({
  orthancClient: { getInstanceFile: jest.fn() },
}));
jest.mock("../../../src/clients/inference.client", () => ({
  segmentDicom: jest.fn(),
}));
jest.mock("../../../src/shared/audit", () => ({
  logAction: jest.fn(),
  AUDIT_ACTIONS: {},
}));

import * as repo from "../../../src/modules/segmentation/segmentation.repository";
import { orthancClient } from "../../../src/clients/orthanc.client";
import { segmentDicom } from "../../../src/clients/inference.client";
import { runSegmentation } from "../../../src/modules/segmentation/segmentation.service";
import { HttpError } from "../../../src/shared/http-error";

const findId = repo.findOrthancInstanceId as jest.Mock<any>;
const insert = repo.insertSegmentation as jest.Mock<any>;
const getFile = orthancClient.getInstanceFile as jest.Mock<any>;
const segment = segmentDicom as jest.Mock<any>;

const RESULT = {
  segmentationId: null,
  seed: 42,
  model: "medsam3",
  simulated: false,
  contour: [{ x: 1, y: 2 }],
  mask: { width: 512, height: 256, rle: [10, 5, 10], pixelCount: 5 },
  derived: {
    sopInstanceUid: "1.2.3",
    seriesInstanceUid: "1.2.4",
    seriesDescription: "s",
    referencedSopInstanceUid: "9.9",
    referencedSopClassUid: null,
    derivationDescription: "d",
  },
  inferenceMs: 340,
};

async function errorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  jest.clearAllMocks();
  findId.mockResolvedValue("orthanc-inst-1");
  getFile.mockResolvedValue({ data: new Uint8Array([68, 73, 67, 77]).buffer });
  segment.mockResolvedValue(RESULT);
  insert.mockResolvedValue({ id: 77 });
});

describe("runSegmentation", () => {
  it("fetches the stored DICOM, forwards it, persists the candidate and returns its id", async () => {
    const out = await runSegmentation(
      { sopInstanceUid: "9.9", studyInstanceUid: "1.1", seed: 42, points: 64 },
      { userId: 5 },
    );

    expect(findId).toHaveBeenCalledWith("9.9");
    expect(getFile).toHaveBeenCalledWith("orthanc-inst-1");
    const [dicom, options] = segment.mock.calls[0] as [Buffer, any];
    expect(Buffer.isBuffer(dicom)).toBe(true);
    expect(dicom.toString()).toBe("DICM");
    expect(options).toEqual({
      seed: 42,
      points: 64,
      smoothingPasses: undefined,
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        studyId: "1.1",
        instanceId: "9.9",
        modelId: "medsam3",
        maskRle: [10, 5, 10],
        maskShape: [256, 512],
        status: "candidate",
        createdBy: 5,
      }),
    );
    expect(out).toEqual({ ...RESULT, segmentationId: 77 });
  });

  it("does not persist without a user, and returns segmentationId null", async () => {
    const out = await runSegmentation({ sopInstanceUid: "9.9" });
    expect(insert).not.toHaveBeenCalled();
    expect(out.segmentationId).toBeNull();
  });

  it("clamps points/smoothingPasses and rejects non-numeric ones", async () => {
    await runSegmentation({
      sopInstanceUid: "9.9",
      points: 9999,
      smoothingPasses: -3,
    });
    expect(segment.mock.calls[0][1]).toEqual({
      seed: undefined,
      points: 512,
      smoothingPasses: 0,
    });

    const err = await errorOf(
      runSegmentation({ sopInstanceUid: "9.9", points: "lots" as any }),
    );
    expect(err.status).toBe(400);
  });

  it("422 for an image opened off the local disk (no source UID)", async () => {
    const err = await errorOf(runSegmentation({}, { userId: 5 }));
    expect(err.status).toBe(422);
    expect(findId).not.toHaveBeenCalled();
    expect(segment).not.toHaveBeenCalled();
  });

  it("404 when the instance is not stored on the server", async () => {
    findId.mockResolvedValueOnce(null);
    const err = await errorOf(runSegmentation({ sopInstanceUid: "nope" }));
    expect(err.status).toBe(404);
    expect(segment).not.toHaveBeenCalled();
  });

  it("404 when Orthanc no longer has the file, 503 when Orthanc is down", async () => {
    getFile.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404 },
    });
    expect(
      (await errorOf(runSegmentation({ sopInstanceUid: "9.9" }))).status,
    ).toBe(404);

    getFile.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(
      (await errorOf(runSegmentation({ sopInstanceUid: "9.9" }))).status,
    ).toBe(503);
    expect(segment).not.toHaveBeenCalled();
  });

  it("propagates the inference service's error and persists nothing", async () => {
    segment.mockRejectedValueOnce(new HttpError(503, { error: "down" }));
    const err = await errorOf(
      runSegmentation({ sopInstanceUid: "9.9" }, { userId: 5 }),
    );
    expect(err.status).toBe(503);
    expect(insert).not.toHaveBeenCalled();
  });
});
