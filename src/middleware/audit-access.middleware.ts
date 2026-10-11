import { RequestHandler } from "express";
import { logAction, AuditAction, AUDIT_ACTIONS } from "../shared/audit";

/**
 * True for an error response worth a `*_FAILED` audit row. 429s are skipped:
 * a client hammering the rate limiter must not also flood the append-only log.
 */
function isAuditableFailure(statusCode: number): boolean {
  return statusCode >= 400 && statusCode !== 429;
}

/**
 * Log a study-access action (TK-06) once the response has actually
 * succeeded. Firing on `res.on("finish")` — rather than before the handler
 * runs — never delays or fails the response itself if the audit write errors.
 * Mounted after requireRole, so unauthorized (401/403) requests never reach it.
 *
 * `param` names the route param holding the study id (default `studyId`;
 * legacy `/api/studies/:id` routes pass `"id"`). Routes with no single
 * resource in scope (list endpoints) fall back to resourceId `"all"`.
 *
 * With `failureAction`, an error response is logged under that action with
 * its status in `detail`; without it, failures stay out of the trail.
 */
export const auditStudyAccess = (
  action: AuditAction,
  param: string = "studyId",
  failureAction?: AuditAction,
): RequestHandler => {
  return (req, res, next) => {
    res.on("finish", () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      if (!ok && !(failureAction && isAuditableFailure(res.statusCode))) {
        return;
      }
      void logAction({
        userId: req.user?.sub ?? null,
        action: ok ? action : failureAction!,
        resourceId: req.params[param] ?? "all",
        ip: req.ip ?? "",
        detail: ok ? undefined : { status: res.statusCode },
      });
    });
    next();
  };
};

/**
 * Log a failed upload as STUDY_UPLOAD_FAILED. Successful uploads are logged
 * by the controller, which is the only place the new study id is known. Must
 * run before multer so a rejected (e.g. oversized, 413) body is still logged.
 */
export const auditUploadFailure: RequestHandler = (req, res, next) => {
  res.on("finish", () => {
    if (!isAuditableFailure(res.statusCode)) return;
    void logAction({
      userId: req.user?.sub ?? null,
      action: AUDIT_ACTIONS.STUDY_UPLOAD_FAILED,
      resourceId: "unknown",
      ip: req.ip ?? "",
      detail: { status: res.statusCode },
    });
  });
  next();
};
