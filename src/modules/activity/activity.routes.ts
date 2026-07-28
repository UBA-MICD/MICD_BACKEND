import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { getActivity, exportActivity } from "./activity.controller";

const router = Router();

router.get("/export", requireAuth, exportActivity);
router.get("/", requireAuth, getActivity);

export default router;
