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
import { searchZenodo, getZenodoRecord } from "./zenodo-search.service";
import {
  importFromZenodo,
  getImport,
  getImportFiles,
  type ImportFileSpec,
} from "./zenodo-import.service";
import {
  getSyncConfig,
  setSyncConfig,
  runSync,
  getSyncLogs,
  getSyncStatus,
  isValidInterval,
  SyncAlreadyRunningError,
  type SyncInterval,
} from "./zenodo-sync.service";
import { getQuotaStatus, getRequestCount, THROTTLE_AT } from "./zenodo-rate-limit.service";
import { Request } from "express";

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

// ── Search (ZEN-06) ──────────────────────────────────────────────────────────

function parseEnvironment(req: Request): ZenodoEnvironment {
  const env = req.query.environment as string;
  return isEnvironment(env) ? env : "production";
}

// Query params: q, page, size, file_type, license, date_from, date_to, keywords, environment
export const search: RequestHandler = async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim() ?? "";

  if (!q) {
    res.status(400).json({ error: "El parámetro q es requerido" });
    return;
  }

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size as string) || 20));
  const environment = parseEnvironment(req);

  try {
    const result = await searchZenodo(
      {
        q,
        page,
        size,
        fileType: (req.query.file_type as string) || undefined,
        license: (req.query.license as string) || undefined,
        dateFrom: (req.query.date_from as string) || undefined,
        dateTo: (req.query.date_to as string) || undefined,
        keywords: (req.query.keywords as string) || undefined,
      },
      environment,
    );

    if (result.records.length === 0) {
      res.json({
        ...result,
        message: "No se encontraron datasets con esos términos",
        suggestions: [
          'Probá términos más generales (ej: "DICOM" en lugar de "CT lung DICOM")',
          "Remové filtros de tipo de archivo o licencia",
          "Revisá la ortografía",
        ],
      });
      return;
    }

    res.json(result);
  } catch (err: unknown) {
    const axiosErr = err as any;
    if (axiosErr?.response?.status === 429) {
      res.status(429).json({
        error: "Límite de requests a Zenodo alcanzado. Intentá de nuevo en unos minutos.",
        retryAfter: axiosErr.response.headers?.["retry-after"],
      });
      return;
    }
    const isNetworkErr =
      axiosErr?.code === "ECONNABORTED" ||
      axiosErr?.code === "ECONNREFUSED" ||
      axiosErr?.code === "ETIMEDOUT";
    if (isNetworkErr || axiosErr?.response?.status >= 500) {
      res.status(503).json({
        error: "Zenodo no está disponible en este momento. Intentá de nuevo más tarde.",
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al buscar en Zenodo:", message);
    res.status(500).json({ error: "Error al realizar la búsqueda" });
  }
};

// Query params: environment
export const getRecordDetail: RequestHandler = async (req, res) => {
  const recordId = parseInt(req.params.recordId, 10);
  if (isNaN(recordId)) {
    res.status(400).json({ error: "recordId inválido" });
    return;
  }

  const environment = parseEnvironment(req);
  console.log(`[zenodo] getRecordDetail — recordId=${recordId} environment=${environment}`);

  try {
    const record = await getZenodoRecord(recordId, environment);
    console.log(`[zenodo] getRecordDetail — importable=${record.importable} files=${JSON.stringify((record.files ?? []).map(f => ({ key: f.key, size: f.size })))}`);

    if (!record.importable) {
      res.json({
        ...record,
        importNote:
          "Este dataset no contiene archivos .dcm ni .zip. No puede ser importado directamente al sistema.",
      });
      return;
    }

    res.json(record);
  } catch (err: unknown) {
    const axiosErr = err as any;
    if (axiosErr?.response?.status === 404) {
      res.status(404).json({ error: "Record no encontrado en Zenodo" });
      return;
    }
    const isNetworkErr =
      axiosErr?.code === "ECONNABORTED" ||
      axiosErr?.code === "ECONNREFUSED" ||
      axiosErr?.code === "ETIMEDOUT";
    if (isNetworkErr || axiosErr?.response?.status >= 500) {
      res.status(503).json({
        error: "Zenodo no está disponible en este momento. Intentá de nuevo más tarde.",
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener el record de Zenodo:", message);
    res.status(500).json({ error: "Error al obtener el detalle del record" });
  }
};

// ── Import (ZEN-07) ──────────────────────────────────────────────────────────

function isFileSpecArray(value: unknown): value is ImportFileSpec[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as Record<string, unknown>).fileKey === "string",
    )
  );
}

// Body: { record_id, environment, files: [{ fileKey, fileSize? }], overwrite_duplicates? }
export const importRecord: RequestHandler = async (req, res) => {
  const { record_id, environment, files, overwrite_duplicates } = req.body ?? {};
  console.log(`[zenodo] importRecord received — record_id=${record_id} environment=${environment} files=${JSON.stringify(files)}`);

  const recordId = parseInt(record_id, 10);
  if (isNaN(recordId)) {
    res.status(400).json({ error: "record_id debe ser un número entero" });
    return;
  }
  if (!isEnvironment(environment)) {
    res.status(400).json({ error: "environment inválido, debe ser sandbox o production" });
    return;
  }
  if (!isFileSpecArray(files)) {
    res.status(400).json({
      error: "files debe ser un array no vacío de objetos { fileKey: string, fileSize?: number }",
    });
    return;
  }

  // Warn on non-DICOM files — but don't block; service will skip .zip
  const nonDcm = (files as ImportFileSpec[]).filter(
    (f) => !f.fileKey.toLowerCase().endsWith(".dcm") && !f.fileKey.toLowerCase().endsWith(".zip"),
  );
  if (nonDcm.length === files.length) {
    res.status(400).json({
      error: "Ninguno de los archivos seleccionados es .dcm o .zip",
      files: nonDcm.map((f) => f.fileKey),
    });
    return;
  }

  try {
    const result = await importFromZenodo({
      recordId,
      environment,
      files,
      overwriteDuplicates: overwrite_duplicates === true,
      userId: req.user!.sub,
      ip: req.ip ?? "",
    });

    console.log(`[zenodo-import] importFromZenodo result — imported=${result.imported} duplicates=${result.duplicates} failed=${result.failed} results=${JSON.stringify(result.results.map(r => ({ fileKey: r.fileKey, status: r.status, error: r.error })))}`);
    const httpStatus = result.imported > 0 ? 201 : result.duplicates > 0 ? 200 : 422;

    const skipped = result.results.filter((r) => r.status === "skipped").length;
    const failedResults = result.results.filter((r) => r.status === "failed");
    const unprocessableError =
      httpStatus === 422
        ? skipped > 0 && result.failed === 0
          ? "Los archivos ZIP no son importables directamente. Descomprimí el archivo y subí los .dcm individualmente."
          : failedResults.length > 0
            ? failedResults[0].error ?? "No se pudo importar ningún archivo."
            : "No se encontraron archivos importables en este registro."
        : undefined;

    res.status(httpStatus).json({
      import_id: result.importId,
      source_doi: result.sourceDoi,
      imported: result.imported,
      duplicates: result.duplicates,
      failed: result.failed,
      results: result.results,
      ...(unprocessableError ? { error: unprocessableError } : {}),
      ...(result.largeSizeWarning
        ? { warning: "El dataset supera los 10 GB. La descarga puede tardar varios minutos." }
        : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al importar desde Zenodo:", message);
    res.status(500).json({ error: "Error interno al importar el dataset" });
  }
};

export const getImportStatus: RequestHandler = async (req, res) => {
  const importId = parseInt(req.params.importId, 10);
  if (isNaN(importId)) {
    res.status(400).json({ error: "importId inválido" });
    return;
  }

  try {
    const importJob = await getImport(importId);
    if (!importJob) {
      res.status(404).json({ error: "Importación no encontrada" });
      return;
    }
    const files = await getImportFiles(importId);
    res.json({ import: importJob, files });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener la importación:", message);
    res.status(500).json({ error: "Error al obtener el estado de la importación" });
  }
};

// ── Periodic metadata sync (ZEN-10) ──────────────────────────────────────────

export const getSyncConfiguration: RequestHandler = async (_req, res) => {
  try {
    const config = await getSyncConfig();
    res.json({
      interval_hours: config.intervalHours,
      last_run_at: config.lastRunAt,
      updated_at: config.updatedAt,
      valid_intervals: [6, 12, 24, 168],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener la configuración de sincronización:", message);
    res.status(500).json({ error: "Error al obtener la configuración" });
  }
};

// Body: { interval_hours: 6 | 12 | 24 | 168 | null }
export const setSyncConfiguration: RequestHandler = async (req, res) => {
  const { interval_hours } = req.body ?? {};

  if (interval_hours !== null && interval_hours !== undefined && !isValidInterval(interval_hours)) {
    res.status(400).json({
      error: "interval_hours inválido. Valores permitidos: 6, 12, 24, 168, o null para desactivar",
    });
    return;
  }

  try {
    const config = await setSyncConfig((interval_hours ?? null) as SyncInterval | null);
    res.json({
      interval_hours: config.intervalHours,
      last_run_at: config.lastRunAt,
      updated_at: config.updatedAt,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al actualizar la configuración de sincronización:", message);
    res.status(500).json({ error: "Error al actualizar la configuración" });
  }
};

// Manual trigger
export const runSyncNow: RequestHandler = async (req, res) => {
  try {
    const result = await runSync({ userId: req.user!.sub, ip: req.ip ?? "" });
    res.json({
      log_id: result.logId,
      records_checked: result.recordsChecked,
      new_versions: result.newVersions,
      errors: result.errors,
    });
  } catch (err: unknown) {
    if (err instanceof SyncAlreadyRunningError) {
      res.status(409).json({
        error: "Ya hay una sincronización en curso",
        status: await getSyncStatus(),
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error durante la sincronización manual:", message);
    res.status(500).json({ error: "Error durante la sincronización" });
  }
};

export const getSyncLogList: RequestHandler = async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  try {
    const logs = await getSyncLogs(limit);
    res.json({ logs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener los logs de sincronización:", message);
    res.status(500).json({ error: "Error al obtener los logs" });
  }
};

export const getSyncStatusHandler: RequestHandler = async (_req, res) => {
  try {
    res.json(await getSyncStatus());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al obtener el estado de la sincronización:", message);
    res.status(500).json({ error: "Error al obtener el estado" });
  }
};

// ── Quota & rate limit (ZEN-17) ──────────────────────────────────────────────

// GET /api/v1/zenodo/quota?environment=production
export const getQuota: RequestHandler = async (req, res) => {
  const environment = (req.query.environment as string) ?? "production";

  if (!isEnvironment(environment)) {
    res.status(400).json({ error: "environment inválido, debe ser sandbox o production" });
    return;
  }

  try {
    const [quota, requestCount] = await Promise.all([
      getQuotaStatus(environment),
      getRequestCount(environment),
    ]);

    res.json({
      environment,
      used_bytes: quota.usedBytes,
      limit_bytes: quota.limitBytes,
      percent_used: Math.round(quota.percentUsed * 1000) / 10,
      alert: quota.alert,
      alert_message: quota.alertMessage,
      rate_limit: {
        requests_last_minute: requestCount,
        throttle_at: THROTTLE_AT,
        limit: 60,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error al consultar la cuota de Zenodo:", message);
    res.status(500).json({ error: "Error al consultar el estado de la cuota" });
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
