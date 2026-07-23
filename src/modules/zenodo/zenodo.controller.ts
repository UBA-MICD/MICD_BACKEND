import { RequestHandler } from "express";
import * as zenodoService from "./zenodo.service";
import {
  ZENODO_ENVIRONMENTS,
  type ZenodoEnvironment,
  ZenodoTokenError,
} from "./zenodo.service";

function isEnvironment(value: unknown): value is ZenodoEnvironment {
  return (
    typeof value === "string" && (ZENODO_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

// ── Credentials configuration (ZEN-01) ───────────────────────────────────────

export const configureToken: RequestHandler = async (req, res) => {
  const { token, environment } = req.body ?? {};

  if (!isEnvironment(environment)) {
    res.status(400).json({ error: "environment inválido, debe ser sandbox o production" });
    return;
  }
  if (typeof token !== "string" || token.trim() === "") {
    res.status(400).json({ error: "token requerido" });
    return;
  }

  try {
    const { hint } = await zenodoService.configureZenodoToken(
      token,
      environment,
      req.user!.sub,
      req.ip ?? "",
    );
    res.status(200).json({ status: "connected", environment, hint });
  } catch (err: unknown) {
    if (err instanceof ZenodoTokenError) {
      res.status(400).json({ error: err.message, reason: err.reason });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al guardar la configuración de Zenodo:", message);
    res.status(500).json({ error: "Error al guardar la configuración" });
  }
};

export const getConfigStatus: RequestHandler = async (_req, res) => {
  try {
    res.json(await zenodoService.getConfigStatus());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener el estado de Zenodo:", message);
    res.status(500).json({ error: "Error al obtener el estado de configuración" });
  }
};

export const getHealth: RequestHandler = async (_req, res) => {
  try {
    res.json(await zenodoService.getHealthStatus());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener el estado de salud de Zenodo:", message);
    res.status(500).json({ error: "Error al obtener el estado de salud" });
  }
};

export const removeConfig: RequestHandler = async (req, res) => {
  const { environment } = req.params;

  if (!isEnvironment(environment)) {
    res.status(400).json({ error: "environment inválido, debe ser sandbox o production" });
    return;
  }

  try {
    await zenodoService.removeZenodoConfig(environment, req.user!.sub, req.ip ?? "");
    res.status(200).json({ message: "Configuración eliminada" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al eliminar la configuración de Zenodo:", message);
    res.status(500).json({ error: "Error al eliminar la configuración" });
  }
};
