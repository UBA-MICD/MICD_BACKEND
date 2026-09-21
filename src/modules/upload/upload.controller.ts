import { RequestHandler } from "express";
import { sendError, isHttpError } from "../../shared/http-error";
import { logAction, AUDIT_ACTIONS } from "../../shared/audit";
import { uploadDicom, processBatchInBackground } from "./upload.service";
import { ensureAnonymizerAvailable } from "./anonymization.service";
import * as anonRepo from "./anonymization.repository";

/**
 * POST handler for single-file DICOM ingest (shared by the v1 and legacy upload
 * routes). Anonymization is fail-closed: a health preflight rejects the upload
 * up front if the module is down (AC3), and `uploadDicom` anonymizes+validates
 * before storing (AC1). Returns 201 with the study + anonymization job id.
 */
export const uploadStudy: RequestHandler = async (req, res) => {
  console.log(
    `[upload] received — file=${req.file?.originalname ?? "none"} size=${req.file?.size ?? 0} mimetype=${req.file?.mimetype ?? "none"}`,
  );
  if (!req.file) {
    console.log(
      `[upload] no file in request — body keys: ${Object.keys(req.body ?? {}).join(", ")}`,
    );
    res.status(400).json({ error: "No DICOM file provided (field: file)" });
    return;
  }

  try {
    await ensureAnonymizerAvailable();

    const result = await uploadDicom(
      { buffer: req.file.buffer, size: req.file.size },
      req.query.force === "true",
    );
    // Resource id is only known once Orthanc/Postgres assign it, so the
    // audit write happens here rather than via param-based middleware (TK-06).
    void logAction({
      userId: req.user?.sub ?? null,
      action: AUDIT_ACTIONS.STUDY_UPLOADED,
      resourceId: String(result.study.orthanc_study_id),
      ip: req.ip ?? "",
    });
    void logAction({
      userId: req.user?.sub ?? null,
      action: AUDIT_ACTIONS.STUDY_ANONYMIZED,
      resourceId: String(result.study.orthanc_study_id),
      ip: req.ip ?? "",
    });
    res.status(201).json(result);
  } catch (err) {
    // A rejected anonymization (nothing stored) is an auditable security event.
    if (
      isHttpError(err) &&
      (err.body as any)?.error === "anonymization_failed"
    ) {
      void logAction({
        userId: req.user?.sub ?? null,
        action: AUDIT_ACTIONS.STUDY_ANONYMIZATION_FAILED,
        resourceId: String((err.body as any)?.jobId ?? "unknown"),
        ip: req.ip ?? "",
      });
    }
    sendError(res, err);
  }
};

/**
 * POST handler for multi-file (study) ingest. Anonymizes the whole batch off
 * the request and returns 202 immediately with a job id the client polls, so a
 * large study shows "procesando" instead of blocking the request (US-16 large-
 * study edge case). Fail-closed: nothing is stored until it anonymizes and
 * validates.
 */
export const uploadStudyBatch: RequestHandler = async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "No DICOM files provided (field: files)" });
    return;
  }

  try {
    await ensureAnonymizerAvailable();

    const jobId = await anonRepo.createJob(files.length);
    const payload = files.map((f) => ({
      name: f.originalname || "study.dcm",
      buffer: f.buffer,
    }));
    const force = req.query.force === "true";

    // Fire-and-forget: the response returns now; the job carries the outcome.
    void processBatchInBackground(jobId, payload, force);

    res
      .status(202)
      .json({ jobId, status: "procesando", fileCount: files.length });
  } catch (err) {
    sendError(res, err);
  }
};

/** GET handler exposing an anonymization job's status to the explorer/upload UI. */
export const getAnonymizationStatus: RequestHandler = async (req, res) => {
  try {
    const job = await anonRepo.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Anonymization job not found" });
      return;
    }
    res.status(200).json({
      jobId: job.jobUuid,
      status: job.status,
      studyRef: job.studyRef,
      tagsProcessed: job.tagsProcessed,
      fileCount: job.fileCount,
      error: job.errorMessage,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  } catch (err) {
    sendError(res, err);
  }
};
