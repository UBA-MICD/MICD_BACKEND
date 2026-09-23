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

// Multi-file (study) uploads use the same in-memory storage and per-file size
// ceiling; only the field name and count differ (US-16 batch endpoint).
const MAX_BATCH_FILES = 1000;
const multiFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadConfig.maxFileBytes, files: MAX_BATCH_FILES },
}).array("files", MAX_BATCH_FILES);

/** Shared multer error → HTTP status mapping (413 too big / 400 malformed). */
function handleMulterError(
  err: unknown,
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
): void {
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
}

/**
 * multer reports a tripped limit by calling next(err), and these routes have no
 * error-handling middleware — without this wrapper the default express handler
 * turns every one of them into a 500 HTML page.
 */
export const uploadSingleFile: RequestHandler = (req, res, next) => {
  singleFile(req, res, (err: unknown) => handleMulterError(err, res, next));
};

/** Same as {@link uploadSingleFile} but for the `files` field (study batch). */
export const uploadMultipleFiles: RequestHandler = (req, res, next) => {
  multiFile(req, res, (err: unknown) => handleMulterError(err, res, next));
};
