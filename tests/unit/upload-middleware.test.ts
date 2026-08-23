/**
 * The upload middleware is what stands between a multipart request and the
 * whole body being buffered into memory, so these cases drive it through a real
 * express app instead of calling it directly — the failure mode under test
 * (multer aborting the stream and surfacing a typed error) only happens on a
 * genuine request.
 *
 * The ceiling is driven by MAX_UPLOAD_BYTES so the oversized case can use a few
 * KB rather than allocating the 500 MB production limit.
 */
import express from "express";
import request from "supertest";

const ORIGINAL_ENV = { ...process.env };

/** Fresh express app with the upload middleware rebuilt at the given ceiling. */
function appWithLimit(maxBytes: number) {
  process.env.MAX_UPLOAD_BYTES = String(maxBytes);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { uploadSingleFile } = require("../../src/middleware/upload.middleware");

  const app = express();
  app.post("/upload", uploadSingleFile, (req: any, res: any) => {
    res.status(201).json({ size: req.file?.size ?? 0 });
  });
  return app;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("upload.middleware — size ceiling", () => {
  it("accepts a file under the ceiling", async () => {
    const res = await request(appWithLimit(4096))
      .post("/upload")
      .attach("file", Buffer.alloc(512, 1), "small.dcm");

    expect(res.status).toBe(201);
    expect(res.body.size).toBe(512);
  });

  it("rejects an oversized file with 413 and a JSON body", async () => {
    const res = await request(appWithLimit(1024))
      .post("/upload")
      .attach("file", Buffer.alloc(64 * 1024, 1), "big.dcm");

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/exceed/i);
  });

  it("rejects an unexpected file field with 400 rather than a 500", async () => {
    const res = await request(appWithLimit(4096))
      .post("/upload")
      .attach("unexpected", Buffer.alloc(64, 1), "x.dcm");

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("rejects a second file in the same request", async () => {
    const res = await request(appWithLimit(4096))
      .post("/upload")
      .attach("file", Buffer.alloc(64, 1), "a.dcm")
      .attach("file", Buffer.alloc(64, 1), "b.dcm");

    expect(res.status).toBe(400);
  });
});
