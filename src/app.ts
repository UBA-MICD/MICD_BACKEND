import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { openapiSpec } from "./openapi";
import { healthRouter } from "./modules/health/health.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { studiesRouter } from "./modules/studies/studies.routes";
import { uploadRouter } from "./modules/upload/upload.routes";

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

app.use("/api", healthRouter); // public: /api/health
app.use(studiesRouter); // /api/studies*, /api/v1/studies* (auth-gated)
app.use(uploadRouter); // /api/v1/studies/upload, /api/instances (auth-gated)

export default app;
