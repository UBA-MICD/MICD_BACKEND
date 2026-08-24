import { RequestHandler } from "express";
import { logAction, AuditAction } from "../shared/audit";

/**
 * Log a study-access action (TK-06) once the response has actually
 * succeeded. Firing on `res.on("finish")` — rather than before the handler
 * runs — keeps failed/unauthorized attempts out of the append-only trail and
 * never delays or fails the response itself if the audit write errors.
 *
 * `param` names the route param holding the study id (default `studyId`;
 * legacy `/api/studies/:id` routes pass `"id"`). Routes with no single
 * resource in scope (list endpoints) fall back to resourceId `"all"`.
 */
export const auditStudyAccess = (
  action: AuditAction,
  param: string = "studyId",
): RequestHandler => {
  return (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      void logAction({
        userId: req.user?.sub ?? null,
        action,
        resourceId: req.params[param] ?? "all",
        ip: req.ip ?? "",
      });
    });
    next();
  };
};
