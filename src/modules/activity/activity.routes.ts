import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import { getActivity, exportActivity } from "./activity.controller";

// The audit log is admin-only.
const router = Router();

router.get("/export", requireAuth, requireRole("admin"), exportActivity);
router.get("/", requireAuth, requireRole("admin"), getActivity);

export default router;
