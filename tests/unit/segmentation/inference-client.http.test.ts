/**
 * The inference client against a real (local) HTTP server, with real axios —
 * so the multipart encoding the Python service parses is actually exercised,
 * not mocked away.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";

const RESULT = {
  segmentationId: null,
  seed: 7,
  model: "mock-sam3",
  modelVersion: null,
  simulated: true,
  contour: [{ x: 1, y: 1 }],
  mask: { width: 2, height: 2, rle: [1, 2, 1], pixelCount: 2 },
  derived: {
    sopInstanceUid: "1.2.3",
    seriesInstanceUid: "1.2.4",
    seriesDescription: "s",
    referencedSopInstanceUid: null,
    referencedSopClassUid: null,
    derivationDescription: "d",
  },
  inferenceMs: 3,
};

let server: http.Server;
let received: {
  path: string;
  contentType: string;
  key: string | undefined;
  body: string;
} | null = null;
let segmentDicom: typeof import("../../../src/clients/inference.client").segmentDicom;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = {
        path: req.url ?? "",
        contentType: req.headers["content-type"] ?? "",
        key: req.headers["x-inference-key"] as string | undefined,
        body: Buffer.concat(chunks).toString("latin1"),
      };
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(RESULT));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  // config/env is read on import, so point it at this server first.
  process.env.AI_INFERENCE_URL = `http://127.0.0.1:${port}`;
  process.env.AI_INFERENCE_API_KEY = "s3cret";
  ({ segmentDicom } = await import("../../../src/clients/inference.client"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("segmentDicom over real HTTP", () => {
  it("sends a multipart body the service can parse and returns its result", async () => {
    const out = await segmentDicom(Buffer.from("DICM-bytes"), {
      seed: 7,
      points: 64,
      smoothingPasses: 1,
      frame: 3,
    });

    expect(out).toEqual(RESULT);
    expect(received!.path).toBe("/segmentation");
    expect(received!.key).toBe("s3cret");
    expect(received!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const body = received!.body;
    expect(body).toMatch(/name="file"; filename="image\.dcm"/);
    expect(body).toMatch(/Content-Type: application\/dicom/);
    expect(body).toContain("DICM-bytes");
    expect(body).toMatch(/name="seed"\r\n\r\n7\r\n/);
    expect(body).toMatch(/name="points"\r\n\r\n64\r\n/);
    expect(body).toMatch(/name="smoothing_passes"\r\n\r\n1\r\n/);
    expect(body).toMatch(/name="frame"\r\n\r\n3\r\n/);
  });
});
