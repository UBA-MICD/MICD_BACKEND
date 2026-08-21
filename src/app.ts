import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { openapiSpec } from "./openapi";
import { isHttpError, sendError } from "./shared/http-error";
import { healthRouter } from "./modules/health/health.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { studiesRouter } from "./modules/studies/studies.routes";
import { uploadRouter } from "./modules/upload/upload.routes";
import { zenodoRouter } from "./modules/zenodo/zenodo.routes";
import activityRouter from "./modules/activity/activity.routes";

/**
 * Assemble the Express application from the feature routers. This module holds
 * no route logic and does not start a listener — server.ts owns the bootstrap
 * so the app can be imported by tests without side effects.
 */
export const app = express();

// Trust exactly one hop (the nginx reverse proxy in front of the web
// deployment) so req.ip / X-Forwarded-For-derived values — used by the login
// rate limiter to key on the real client IP — aren't just nginx's container IP
// for every request.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

app.use("/auth", authRouter); // public: /auth/login, /auth/refresh, /auth/logout

// ── API docs (Swagger UI) ─────────────────────────────────────────────────────
app.get("/api/docs/openapi.json", (_req, res) => res.json(openapiSpec));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

app.use("/api", healthRouter); // public: /api/livez, /api/readyz, /api/health (alias)
app.use(studiesRouter); // /api/studies*, /api/v1/studies* (auth-gated)
app.use(uploadRouter); // /api/v1/studies/upload, /api/instances (auth-gated)
app.use("/api/v1/zenodo", zenodoRouter); // Zenodo integration (auth-gated)
app.use("/api/v1/activity", activityRouter); // Audit log reader (auth-gated)

// ── Fallthrough handlers ──────────────────────────────────────────────────────
// Unmatched route → JSON 404 (not Express's default HTML page).
app.use((_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Global error handler. Services throw HttpError; requireRole and controllers
// that forward with next(err) (e.g. activity.controller) land here. Map an
// HttpError to its declared status/body, log and generalize anything else to a
// JSON 500. Before this existed, a forwarded error rendered Express's default
// HTML 500 page — a live defect on the activity routes. The 4-arg signature is
// what marks this as Express error-handling middleware.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (!isHttpError(err)) {
    console.error("Unhandled error:", err);
  }
  sendError(res, err);
});

export default app;
