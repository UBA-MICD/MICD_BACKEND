import { RequestHandler } from "express";
import { pool } from "../../db/pool";
import { orthancClient } from "../../clients/orthanc.client";
import { orthancStorageConfig } from "../../config/env";

/**
 * Liveness probe: process is up and able to answer HTTP. No dependency I/O —
 * a Postgres/Orthanc outage must never fail this, or an orchestrator would
 * restart a perfectly healthy container into a restart loop.
 */
export const livezHandler: RequestHandler = (_req, res) => {
  res.json({ status: "ok" });
};

/**
 * Admin-only: proxies Orthanc's /statistics so the frontend can show storage
 * info without exposing Orthanc's admin credentials to the client.
 *
 * Orthanc's /statistics only reports how many bytes it has stored — it does
 * NOT expose the total filesystem capacity. A percentage is only meaningful
 * when ORTHANC_MAX_STORAGE_MB is configured (an admin-set quota/cap). Without
 * it, disk_used_pct and alert are null so the UI shows absolute numbers only.
 */
export const orthancStatisticsHandler: RequestHandler = async (_req, res) => {
  try {
    const { data } = await orthancClient.getStatistics();
    const usedMb: number = (data.TotalDiskSizeMB as number) ?? 0;
    const maxMb = orthancStorageConfig.maxMb;

    let disk_used_pct: number | null = null;
    let alert: boolean | null = null;
    if (maxMb !== null) {
      const pct = Math.min(100, (usedMb / maxMb) * 100);
      disk_used_pct = Math.round(pct * 10) / 10;
      alert = pct >= orthancStorageConfig.alertPct;
    }

    res.json({
      disk_used_mb: usedMb,
      disk_max_mb: maxMb,
      disk_used_pct,
      alert,
      count_studies: data.CountStudies ?? 0,
      count_series: data.CountSeries ?? 0,
      count_instances: data.CountInstances ?? 0,
    });
  } catch (err: any) {
    res.status(503).json({ error: "Orthanc unreachable", detail: err.message });
  }
};

export const readyzHandler: RequestHandler = async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    const orthanc = await orthancClient.getSystem();
    res.json({ status: "ok", orthanc: orthanc.data.Version });
  } catch (err: any) {
    res.status(503).json({ status: "degraded", error: err.message });
  }
};
