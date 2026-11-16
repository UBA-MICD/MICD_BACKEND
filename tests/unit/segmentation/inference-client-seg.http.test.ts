/**
 * buildSeg against a real (local) HTTP server: exercises the multipart encoding
 * and the X-Seg-* header parsing, not mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";

let server: http.Server;
let received: { path: string; key: string | undefined; body: string } | null =
  null;
let buildSeg: typeof import("../../../src/clients/inference.client").buildSeg;

const SEG_BYTES = Buffer.from("DICM-SEG-BYTES");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = {
        path: req.url ?? "",
        key: req.headers["x-inference-key"] as string | undefined,
        body: Buffer.concat(chunks).toString("latin1"),
      };
      res.writeHead(200, {
        "Content-Type": "application/dicom",
        "X-Seg-Sop-Instance-Uid": "1.2.900.1",
        "X-Seg-Series-Instance-Uid": "1.2.900.2",
      });
      res.end(SEG_BYTES);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  process.env.AI_INFERENCE_URL = `http://127.0.0.1:${port}`;
  process.env.AI_INFERENCE_API_KEY = "s3cret";
  ({ buildSeg } = await import("../../../src/clients/inference.client"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("buildSeg over real HTTP", () => {
  it("posts the DICOM + mask_rle and returns the SEG bytes + minted UIDs", async () => {
    const out = await buildSeg(Buffer.from("SRC-DICOM"), [2, 2, 0], {
      label: "Lesion",
    });

    expect(out.dicom.equals(SEG_BYTES)).toBe(true);
    expect(out.sopInstanceUid).toBe("1.2.900.1");
    expect(out.seriesInstanceUid).toBe("1.2.900.2");
    expect(received!.path).toBe("/segmentation/seg");
    expect(received!.key).toBe("s3cret");
    const body = received!.body;
    expect(body).toMatch(/name="file"; filename="image\.dcm"/);
    expect(body).toContain("SRC-DICOM");
    expect(body).toMatch(/name="mask_rle"\r\n\r\n\[2,2,0\]\r\n/);
    expect(body).toMatch(/name="label"\r\n\r\nLesion\r\n/);
  });
});
