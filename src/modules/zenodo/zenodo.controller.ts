import { RequestHandler } from "express";
import * as zenodoService from "./zenodo.service";
import {
  ZENODO_ENVIRONMENTS,
  type ZenodoEnvironment,
  ZenodoTokenError,
} from "./zenodo.service";
import {
  publishStudy,
  retryFailedFiles,
  getDeposition,
  getDepositionFiles,
  ZenodoPublishError,
  type ZenodoAuthor,
} from "./zenodo-publish.service";

function isEnvironment(value: unknown): value is ZenodoEnvironment {
  return (
    typeof value === "string" && (ZENODO_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

function isAuthorArray(value: unknown): value is ZenodoAuthor[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as Record<string, unknown>).name === "string",
    )
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

// ── Publish to Zenodo (ZEN-05) ───────────────────────────────────────────────

// Body: { orthanc_study_id, environment, title, description, authors, license?, keywords? }
export const publish: RequestHandler = async (req, res) => {
  const { orthanc_study_id, environment, title, description, authors, license, keywords } =
    req.body ?? {};

  if (typeof orthanc_study_id !== "string" || orthanc_study_id.trim() === "") {
    res.status(400).json({ error: "orthanc_study_id requerido" });
    return;
  }
  if (!isEnvironment(environment)) {
    res.status(400).json({ error: "environment inválido, debe ser sandbox o production" });
    return;
  }
  if (typeof title !== "string" || title.trim() === "") {
    res.status(400).json({ error: "title requerido" });
    return;
  }
  if (typeof description !== "string" || description.trim() === "") {
    res.status(400).json({ error: "description requerida" });
    return;
  }
  if (!isAuthorArray(authors) || authors.length === 0) {
    res.status(400).json({ error: "authors debe ser un array no vacío con al menos { name }" });
    return;
  }
  if (keywords !== undefined && !Array.isArray(keywords)) {
    res.status(400).json({ error: "keywords debe ser un array de strings" });
    return;
  }

  const { force_large_upload } = req.body ?? {};

  try {
    const result = await publishStudy({
      orthancStudyId: orthanc_study_id,
      environment,
      metadata: { title, description, authors, license, keywords },
      userId: req.user!.sub,
      ip: req.ip ?? "",
      forceLargeUpload: force_large_upload === true,
    });

    res.status(201).json({
      deposition_id: result.depositionId,
      doi: result.doi,
      files_uploaded: result.filesUploaded,
      total_bytes: result.totalBytes,
    });
  } catch (err: unknown) {
    if (err instanceof ZenodoPublishError) {
      const status =
        err.code === "study_not_found"
          ? 404
          : err.code === "not_anonymized" || err.code === "no_credentials"
            ? 422
            : err.code === "file_too_large"
              ? 413
              : 400;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al publicar en Zenodo:", message);
    res.status(500).json({ error: "Error interno al publicar el estudio" });
  }
};

export const getDepositionStatus: RequestHandler = async (req, res) => {
  const depositionId = parseInt(req.params.depositionId, 10);
  if (isNaN(depositionId)) {
    res.status(400).json({ error: "depositionId inválido" });
    return;
  }

  try {
    const deposition = await getDeposition(depositionId);
    if (!deposition) {
      res.status(404).json({ error: "Depósito no encontrado" });
      return;
    }
    const files = await getDepositionFiles(depositionId);
    res.json({ deposition, files });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener el depósito:", message);
    res.status(500).json({ error: "Error al obtener el estado del depósito" });
  }
};

export const retryDeposition: RequestHandler = async (req, res) => {
  const depositionId = parseInt(req.params.depositionId, 10);
  if (isNaN(depositionId)) {
    res.status(400).json({ error: "depositionId inválido" });
    return;
  }

  try {
    const result = await retryFailedFiles(depositionId, req.user!.sub, req.ip ?? "");
    res.json({ retried: result.retried, failed: result.failed });
  } catch (err: unknown) {
    if (err instanceof ZenodoPublishError) {
      const status = err.code === "deposition_not_found" ? 404 : 422;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al reintentar archivos fallidos:", message);
    res.status(500).json({ error: "Error al reintentar la subida" });
  }
};
