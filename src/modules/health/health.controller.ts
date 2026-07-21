import { RequestHandler } from "express";
import { pool } from "../../db/pool";
import { orthancClient } from "../../clients/orthanc.client";

/**
 * Liveness/readiness probe: confirms Postgres answers a trivial query and
 * Orthanc's /system endpoint is reachable. Returns 503 "degraded" if either
 * dependency is down.
 */
export const healthHandler: RequestHandler = async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    const orthanc = await orthancClient.getSystem();
    res.json({ status: "ok", orthanc: orthanc.data.Version });
  } catch (err: any) {
    res.status(503).json({ status: "degraded", error: err.message });
  }
};
