/**
 * Unit tests for clients/inference.client.ts — how each answer from the Python
 * inference service maps to a result or an HttpError. axios is mocked.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("axios", () => ({ __esModule: true, default: { post: jest.fn() } }));

import axios from "axios";
import {
  parseInferenceResult,
  segmentDicom,
} from "../../../src/clients/inference.client";
import { HttpError } from "../../../src/shared/http-error";

const post = axios.post as unknown as jest.Mock<any>;

const RESULT = {
  segmentationId: null,
  seed: 42,
  model: "mock-sam3",
  modelVersion: null,
  simulated: true,
  contour: [{ x: 1, y: 2 }],
  mask: { width: 4, height: 3, rle: [5, 2, 5], pixelCount: 2 },
  derived: {
    sopInstanceUid: "1.2.3",
    seriesInstanceUid: "1.2.4",
    seriesDescription: "Segmentación IA (mock SAM3)",
    referencedSopInstanceUid: "9.9",
    referencedSopClassUid: null,
    derivationDescription: "x",
  },
  inferenceMs: 12,
};

const DICOM = Buffer.from("DICM");

async function errorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  post.mockReset();
});

describe("segmentDicom", () => {
  it("posts the DICOM and the options as multipart and returns the result", async () => {
    post.mockResolvedValueOnce({ status: 201, data: RESULT });

    const out = await segmentDicom(DICOM, {
      seed: 7,
      points: 64,
      smoothingPasses: 1,
    });

    expect(out).toEqual(RESULT);
    const [url, form, config] = post.mock.calls[0] as [string, FormData, any];
    expect(url).toBe("http://micd-inference:8000/segmentation");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("seed")).toBe("7");
    expect(form.get("points")).toBe("64");
    expect(form.get("smoothing_passes")).toBe("1");
    expect(config.timeout).toBe(30000);
  });

  it("omits the options the caller did not set", async () => {
    post.mockResolvedValueOnce({ status: 201, data: RESULT });
    await segmentDicom(DICOM);
    const form = post.mock.calls[0][1] as FormData;
    expect(form.has("seed")).toBe(false);
    expect(form.has("points")).toBe(false);
    expect(form.has("smoothing_passes")).toBe(false);
  });

  it.each([
    [
      "a timeout",
      () =>
        post.mockRejectedValueOnce({
          code: "ECONNABORTED",
          message: "timeout",
        }),
      504,
    ],
    [
      "a refused connection",
      () =>
        post.mockRejectedValueOnce({
          code: "ECONNREFUSED",
          message: "refused",
        }),
      503,
    ],
    [
      "a 503 from the service (model still loading)",
      () => post.mockResolvedValueOnce({ status: 503, data: {} }),
      503,
    ],
    [
      "a 422 (the model found no region)",
      () =>
        post.mockResolvedValueOnce({ status: 422, data: { detail: "nada" } }),
      422,
    ],
    [
      "a 401 (shared key mismatch)",
      () => post.mockResolvedValueOnce({ status: 401, data: {} }),
      502,
    ],
    [
      "a 400 (not a readable DICOM)",
      () => post.mockResolvedValueOnce({ status: 400, data: {} }),
      422,
    ],
    ["a 500", () => post.mockResolvedValueOnce({ status: 500, data: {} }), 502],
    [
      "a 201 with an invalid body",
      () => post.mockResolvedValueOnce({ status: 201, data: { model: 1 } }),
      502,
    ],
  ])("maps %s to %i", async (_label, arrange, status) => {
    arrange();
    const err = await errorOf(segmentDicom(DICOM));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(status);
  });
});

describe("parseInferenceResult", () => {
  const clone = (): any => JSON.parse(JSON.stringify(RESULT));

  it("passes the service's 422 message through", async () => {
    post.mockResolvedValueOnce({
      status: 422,
      data: { detail: "El modelo no encontró ninguna región en la imagen." },
    });
    const err = await errorOf(segmentDicom(DICOM));
    expect(err.body).toEqual({
      error: "El modelo no encontró ninguna región en la imagen.",
    });
  });

  it("does not send a key header when no key is configured", async () => {
    post.mockResolvedValueOnce({ status: 201, data: RESULT });
    await segmentDicom(DICOM);
    expect((post.mock.calls[0][2] as any).headers).toBeUndefined();
  });

  it("keeps modelVersion and defaults it to null when absent", () => {
    expect(
      parseInferenceResult({
        ...clone(),
        modelVersion: "v3/model.pt@sha256:ab",
      })!.modelVersion,
    ).toBe("v3/model.pt@sha256:ab");
    const { modelVersion: _drop, ...older } = clone();
    expect(parseInferenceResult(older)!.modelVersion).toBeNull();
  });

  it("accepts a well-formed response and copies only known fields", () => {
    const body = { ...clone(), internalDebug: "secret", segmentationId: 999 };
    const out = parseInferenceResult(body)!;
    expect(out).toEqual(RESULT);
    expect(out).not.toHaveProperty("internalDebug");
    expect(out.segmentationId).toBeNull();
  });

  it.each([
    [
      "an RLE that doesn't cover width×height",
      (b: any) => (b.mask.rle = [5, 2, 4]),
    ],
    [
      "a pixelCount that disagrees with the RLE",
      (b: any) => (b.mask.pixelCount = 3),
    ],
    ["a negative run", (b: any) => (b.mask.rle = [6, -1, 7])],
    ["a non-integer width", (b: any) => (b.mask.width = 4.5)],
    [
      "a contour point that isn't numeric",
      (b: any) => (b.contour = [{ x: "1", y: 2 }]),
    ],
    ["a negative seed", (b: any) => (b.seed = -1)],
    ["a non-boolean simulated", (b: any) => (b.simulated = "no")],
    ["a non-string modelVersion", (b: any) => (b.modelVersion = 3)],
    ["a missing derived UID", (b: any) => delete b.derived.sopInstanceUid],
    ["a non-object body", () => "nope"],
  ])("rejects %s", (_label, mutate) => {
    const body = clone();
    const replaced = mutate(body);
    expect(
      parseInferenceResult(replaced === "nope" ? "nope" : body),
    ).toBeNull();
  });
});
