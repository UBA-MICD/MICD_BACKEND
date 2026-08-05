import { RequestHandler } from "express";
import { pool } from "../../db/pool";
import { orthancClient } from "../../clients/orthanc.client";

/**
 * Liveness probe: process is up and able to answer HTTP. No dependency I/O —
 * a Postgres/Orthanc outage must never fail this, or an orchestrator would
 * restart a perfectly healthy container into a restart loop.
 */
export const livezHandler: RequestHandler = (_req, res) => {
  res.json({ status: "ok" });
};

/**
 * Readiness probe: confirms Postgres answers a trivial query and Orthanc's
 * /system endpoint is reachable. Returns 503 "degraded" if either dependency
 * is down — signals "stop routing traffic here", not "restart me".
 */
export const readyzHandler: RequestHandler = async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    const orthanc = await orthancClient.getSystem();
    res.json({ status: "ok", orthanc: orthanc.data.Version });
  } catch (err: any) {
    res.status(503).json({ status: "degraded", error: err.message });
  }
};
