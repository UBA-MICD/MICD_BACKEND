import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.middleware";
import * as ctrl from "./zenodo.controller";

/**
 * Zenodo integration routes, mounted at /api/v1/zenodo in app.ts.
 *
 * These are role-gated per route (the blanket requireAuth this router used to
 * carry is gone):
 *   - Credential + sync configuration and publication are admin-only (they hold
 *     secrets or are irreversible and outward-facing).
 *   - Operational reads, import, and quota are open to clinical staff.
 *   - Public-corpus search/resolve is open to admin, medico and investigador
 *     (not informatico) — it queries Zenodo's own public data and exposes no
 *     local PHI.
 */
export const zenodoRouter = Router();

const ADMIN = [requireAuth, requireRole("admin")];
const STAFF = [requireAuth, requireRole("admin", "medico")];
const VIEWERS = [requireAuth, requireRole("admin", "medico", "investigador")];

// ── Credentials configuration (ZEN-01) — admin ────────────────────────────────
zenodoRouter.post("/config", ...ADMIN, ctrl.configureToken);
zenodoRouter.delete("/config/:environment", ...ADMIN, ctrl.removeConfig);
zenodoRouter.get("/config/status", ...STAFF, ctrl.getConfigStatus);

// ── Panel state (ZEN-02): connection health per environment ──────────────────
zenodoRouter.get("/health", ...STAFF, ctrl.getHealth);

// ── Search (ZEN-06) — public Zenodo corpus, no local PHI ─────────────────────
zenodoRouter.get("/search", ...VIEWERS, ctrl.search);
zenodoRouter.get("/records/:recordId", ...VIEWERS, ctrl.getRecordDetail);

// ── Periodic metadata sync (ZEN-10) ──────────────────────────────────────────
zenodoRouter.get("/config/sync", ...ADMIN, ctrl.getSyncConfiguration);
zenodoRouter.put("/config/sync", ...ADMIN, ctrl.setSyncConfiguration);
zenodoRouter.post("/config/sync/run", ...ADMIN, ctrl.runSyncNow);
zenodoRouter.get("/config/sync/logs", ...STAFF, ctrl.getSyncLogList);
zenodoRouter.get("/config/sync/status", ...STAFF, ctrl.getSyncStatusHandler);

// ── Import (ZEN-07) — clinical staff ─────────────────────────────────────────
zenodoRouter.post("/import", ...STAFF, ctrl.importRecord);
zenodoRouter.get("/imports/:importId", ...STAFF, ctrl.getImportStatus);
zenodoRouter.get("/resolve", ...VIEWERS, ctrl.resolveRecord);

// ── Quota & rate limit (ZEN-17) ──────────────────────────────────────────────
zenodoRouter.get("/quota", ...STAFF, ctrl.getQuota);

// ── Publish (ZEN-05) — admin only: irreversible and outward-facing ───────────
zenodoRouter.post("/publish", ...ADMIN, ctrl.publish);
zenodoRouter.get("/depositions/:depositionId", ...ADMIN, ctrl.getDepositionStatus);
zenodoRouter.post(
  "/depositions/:depositionId/retry",
  ...ADMIN,
  ctrl.retryDeposition,
);
