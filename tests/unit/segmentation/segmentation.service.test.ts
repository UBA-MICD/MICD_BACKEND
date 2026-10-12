/**
 * Unit tests for runSegmentation (TK-44): validate the request, fetch the stored
 * DICOM from Orthanc, forward it to the inference service, persist the candidate
 * under the study the server knows, and audit every attempt. Repo, Orthanc,
 * the inference client and the audit log are mocked.
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
  AUDIT_ACTIONS: {
    AI_SEGMENTATION_REQUESTED: "AI_SEGMENTATION_REQUESTED",
    AI_SEGMENTATION_FAILED: "AI_SEGMENTATION_FAILED",
  },
}));

import * as repo from "../../../src/modules/segmentation/segmentation.repository";
import { orthancClient } from "../../../src/clients/orthanc.client";
import { segmentDicom } from "../../../src/clients/inference.client";
import { logAction } from "../../../src/shared/audit";
import { runSegmentation } from "../../../src/modules/segmentation/segmentation.service";
import { HttpError } from "../../../src/shared/http-error";

const findStored = repo.findStoredInstance as jest.Mock<any>;
const insert = repo.insertSegmentation as jest.Mock<any>;
const getFile = orthancClient.getInstanceFile as jest.Mock<any>;
const segment = segmentDicom as jest.Mock<any>;
const audit = logAction as jest.Mock<any>;

const CTX = { userId: 5, ip: "203.0.113.9" };
const SOP = "1.2.840.99.9";

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
    referencedSopInstanceUid: SOP,
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

const auditedActions = (): string[] =>
  audit.mock.calls.map((c) => (c[0] as { action: string }).action);

beforeEach(() => {
  jest.clearAllMocks();
  findStored.mockResolvedValue({
    orthancInstanceId: "orthanc-inst-1",
    studyInstanceUid: "1.2.840.99",
  });
  getFile.mockResolvedValue({ data: new Uint8Array([68, 73, 67, 77]).buffer });
  segment.mockResolvedValue(RESULT);
  insert.mockResolvedValue({ id: 77 });
});

describe("runSegmentation", () => {
  it("fetches the stored DICOM, forwards it, persists the candidate and returns its id", async () => {
    const out = await runSegmentation(
      { sopInstanceUid: SOP, seed: 42, points: 64 },
      CTX,
    );

    expect(findStored).toHaveBeenCalledWith(SOP);
    expect(getFile).toHaveBeenCalledWith("orthanc-inst-1");
    const [dicom, options] = segment.mock.calls[0] as [Buffer, any];
    expect(dicom.toString()).toBe("DICM");
    expect(options).toEqual({
      seed: 42,
      points: 64,
      smoothingPasses: undefined,
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        studyId: "1.2.840.99",
        instanceId: SOP,
        modelId: "medsam3",
        maskRle: [10, 5, 10],
        maskShape: [256, 512],
        status: "candidate",
        createdBy: 5,
      }),
    );
    expect(out).toEqual({ ...RESULT, segmentationId: 77 });
  });

  it("files the candidate under the stored study, ignoring any study UID the client sends", async () => {
    await runSegmentation(
      { sopInstanceUid: SOP, studyInstanceUid: "9.9.9" } as any,
      CTX,
    );
    expect(insert.mock.calls[0][0]).toMatchObject({ studyId: "1.2.840.99" });
  });

  it("audits a successful attempt with the candidate id", async () => {
    await runSegmentation({ sopInstanceUid: SOP }, CTX);
    expect(audit).toHaveBeenCalledWith({
      userId: 5,
      action: "AI_SEGMENTATION_REQUESTED",
      resourceId: SOP,
      ip: "203.0.113.9",
      detail: { segmentationId: 77, model: "medsam3", simulated: false },
    });
  });

  it("audits a failed attempt with its status and saves nothing", async () => {
    segment.mockRejectedValueOnce(new HttpError(503, { error: "down" }));
    const err = await errorOf(runSegmentation({ sopInstanceUid: SOP }, CTX));
    expect(err.status).toBe(503);
    expect(insert).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AI_SEGMENTATION_FAILED",
        resourceId: SOP,
        detail: { status: 503 },
      }),
    );
  });

  it("clamps points/smoothingPasses and rejects non-numeric ones", async () => {
    await runSegmentation(
      { sopInstanceUid: SOP, points: 9999, smoothingPasses: -3 },
      CTX,
    );
    expect(segment.mock.calls[0][1]).toEqual({
      seed: undefined,
      points: 512,
      smoothingPasses: 0,
    });
    const err = await errorOf(
      runSegmentation({ sopInstanceUid: SOP, points: "lots" }, CTX),
    );
    expect(err.status).toBe(400);
  });

  it.each([
    ["a negative seed", -1],
    ["a fractional seed", 1.5],
    ["a seed above 2^32-1", 2 ** 32],
    ["a non-numeric seed", "abc"],
  ])("400 for %s", async (_label, seed) => {
    const err = await errorOf(
      runSegmentation({ sopInstanceUid: SOP, seed }, CTX),
    );
    expect(err.status).toBe(400);
    expect(segment).not.toHaveBeenCalled();
  });

  it("422 for an image opened off the local disk (no source UID), nothing audited", async () => {
    const err = await errorOf(runSegmentation({}, CTX));
    expect(err.status).toBe(422);
    expect(findStored).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["an object", { $ne: 1 }],
    ["an array", ["1.2", "3.4"]],
    ["letters", "abc.def"],
    ["over 64 chars", `1.${"2".repeat(70)}`],
  ])("400 for a sopInstanceUid that is %s", async (_label, sopInstanceUid) => {
    const err = await errorOf(runSegmentation({ sopInstanceUid }, CTX));
    expect(err.status).toBe(400);
    expect(findStored).not.toHaveBeenCalled();
  });

  it("404 when the instance is not stored on the server", async () => {
    findStored.mockResolvedValueOnce(null);
    const err = await errorOf(runSegmentation({ sopInstanceUid: SOP }, CTX));
    expect(err.status).toBe(404);
    expect(segment).not.toHaveBeenCalled();
    expect(auditedActions()).toEqual(["AI_SEGMENTATION_FAILED"]);
  });

  it("404 when Orthanc no longer has the file, 503 when Orthanc is down", async () => {
    getFile.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404 },
    });
    expect(
      (await errorOf(runSegmentation({ sopInstanceUid: SOP }, CTX))).status,
    ).toBe(404);

    getFile.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(
      (await errorOf(runSegmentation({ sopInstanceUid: SOP }, CTX))).status,
    ).toBe(503);
    expect(segment).not.toHaveBeenCalled();
  });

  it("a database failure is audited as a 500 and rethrown", async () => {
    findStored.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(runSegmentation({ sopInstanceUid: SOP }, CTX)).rejects.toThrow(
      "connection terminated",
    );
    expect(audit.mock.calls[0][0]).toMatchObject({ detail: { status: 500 } });
  });

  it("429 once the concurrency cap is reached, and frees the slot afterwards", async () => {
    const releases: Array<() => void> = [];
    segment.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(RESULT));
        }),
    );
    // Default cap is 4.
    const running = Array.from({ length: 4 }, () =>
      runSegmentation({ sopInstanceUid: SOP }, CTX),
    );
    await new Promise((r) => setTimeout(r, 0));

    const err = await errorOf(runSegmentation({ sopInstanceUid: SOP }, CTX));
    expect(err.status).toBe(429);

    releases.forEach((release) => release());
    await Promise.all(running);
    segment.mockResolvedValue(RESULT);
    await expect(
      runSegmentation({ sopInstanceUid: SOP }, CTX),
    ).resolves.toBeTruthy();
  });
});
