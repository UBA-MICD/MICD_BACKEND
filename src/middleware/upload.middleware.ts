import multer from "multer";

// Store the uploaded file in memory; no size limit here — the upload service
// validates the size and DICOM magic bytes on the buffer.
const upload = multer({ storage: multer.memoryStorage() });

/** Parse a single multipart file from the `file` field into req.file. */
export const uploadSingleFile = upload.single("file");
