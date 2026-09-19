import express from "express";
import swaggerUi from "swagger-ui-express";
import { serverConfig } from "./config/env";
import { corsMiddleware } from "./middleware/cors.middleware";
import { globalRateLimiter } from "./middleware/rate-limit.middleware";
import { openapiSpec } from "./openapi";
import { isHttpError, sendError } from "./shared/http-error";
import { healthRouter } from "./modules/health/health.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { studiesRouter } from "./modules/studies/studies.routes";
import { uploadRouter } from "./modules/upload/upload.routes";
import { zenodoRouter } from "./modules/zenodo/zenodo.routes";
import { segmentationRouter } from "./modules/segmentation/segmentation.routes";
import activityRouter from "./modules/activity/activity.routes";
import usersRouter from "./modules/users/users.routes";

/**
 * Assemble the Express application from the feature routers. This module holds
 * no route logic and does not start a listener — server.ts owns the bootstrap
 * so the app can be imported by tests without side effects.
 */
export const app = express();

// How many proxy hops may set X-Forwarded-For. Defaults to 1 for the nginx
// deployment, where it keeps the login rate limiter keyed on the real client IP
// instead of nginx's container IP. Deployments reached directly — the desktop
// app talking to its own backend — must set TRUST_PROXY=0, otherwise a client
// can forge the header and rotate past the limiter. See config/env.ts.
app.set("trust proxy", serverConfig.trustProxy);

app.use(corsMiddleware);
app.use(express.json());

// Backstop budget for every route (liveness/readiness excepted — see the
// middleware). Route-specific limiters below are tighter where it matters.
app.use(globalRateLimiter);

app.use("/auth", authRouter); // public: /auth/login, /auth/refresh, /auth/logout

// ── API docs (Swagger UI) ─────────────────────────────────────────────────────
app.get("/api/docs/openapi.json", (_req, res) => res.json(openapiSpec));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

app.use("/api", healthRouter); // public: /api/livez, /api/readyz, /api/health (alias)
app.use(studiesRouter); // /api/studies*, /api/v1/studies* (auth-gated)
app.use(uploadRouter); // /api/v1/studies/upload, /api/instances (auth-gated)
app.use("/api/v1/ml", segmentationRouter); // AI segmentation, mock SAM3 (auth-gated)
app.use("/api/v1/zenodo", zenodoRouter); // Zenodo integration (auth-gated)
app.use("/api/v1/activity", activityRouter); // Audit log reader (admin-only)
app.use("/api/v1/users", usersRouter); // User management (admin-only)

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
