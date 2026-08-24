import { RequestHandler } from "express";
import multer from "multer";
import { uploadConfig } from "../config/env";

/**
 * Parse a single multipart file from the `file` field into req.file.
 *
 * The file is held in memory, so the size ceiling has to be enforced *here*:
 * multer aborts the stream as soon as the request exceeds it, which is what
 * keeps an oversized (or endless) body from being buffered into RAM before
 * anything gets a chance to reject it. The upload service re-checks the size of
 * the buffer it receives as defense in depth.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadConfig.maxFileBytes, files: 1 },
});

const singleFile = upload.single("file");

/**
 * multer reports a tripped limit by calling next(err), and these routes have no
 * error-handling middleware — without this wrapper the default express handler
 * turns every one of them into a 500 HTML page. Map them to the same statuses
 * the upload service uses: 413 for "too big", 400 for a malformed request.
 */
export const uploadSingleFile: RequestHandler = (req, res, next) => {
  singleFile(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: `File exceeds maximum allowed size of ${uploadConfig.maxFileBytes} bytes`,
        });
        return;
      }
      res.status(400).json({ error: `Invalid upload request: ${err.code}` });
      return;
    }

    next(err);
  });
};
