import express from "express";
import swaggerUi from "swagger-ui-express";
import { serverConfig } from "./config/env";
import { corsMiddleware } from "./middleware/cors.middleware";
import { openapiSpec } from "./openapi";
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

// How many proxy hops may set X-Forwarded-For. Defaults to 1 for the nginx
// deployment, where it keeps the login rate limiter keyed on the real client IP
// instead of nginx's container IP. Deployments reached directly — the desktop
// app talking to its own backend — must set TRUST_PROXY=0, otherwise a client
// can forge the header and rotate past the limiter. See config/env.ts.
app.set("trust proxy", serverConfig.trustProxy);

app.use(corsMiddleware);
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

export default app;
