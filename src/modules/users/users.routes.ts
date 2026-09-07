import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import * as ctrl from "./users.controller";

/**
 * Admin user-management routes, mounted at /api/v1/users in app.ts. Every route
 * is admin-only. Deletion is a soft-delete (status 'deleted'); the panel never
 * hard-deletes, so the audit trail and zenodo_config.created_by stay intact.
 */
export const usersRouter = Router();

const ADMIN = [requireAuth, requireRole("admin")];

usersRouter.get("/", ...ADMIN, ctrl.listUsers);
usersRouter.post("/", ...ADMIN, ctrl.createUser);
usersRouter.patch("/:id/role", ...ADMIN, ctrl.updateRole);
usersRouter.patch("/:id/status", ...ADMIN, ctrl.updateStatus);
usersRouter.delete("/:id", ...ADMIN, ctrl.deleteUser);
usersRouter.post("/:id/invite", ...ADMIN, ctrl.reinvite);

export default usersRouter;
