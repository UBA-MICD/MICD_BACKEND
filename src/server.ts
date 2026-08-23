import cron from "node-cron";
import { app } from "./app";
import { serverConfig, tlsConfig } from "./config/env";
import { runMigrations } from "./db/migrate";
import { createHttpServer } from "./shared/http-server";
import { checkAllEnvironments } from "./modules/zenodo/zenodo.service";
import {
  shouldRunSync,
  runSync,
  recoverStaleSyncLocks,
} from "./modules/zenodo/zenodo-sync.service";

/**
 * Process entry point: apply migrations (which also seed the shared test user)
 * before accepting traffic. If initialization fails the process exits non-zero
 * so the orchestrator can restart it rather than serving from a half-ready
 * state. Background schedulers live here (not in app.ts) so importing the app
 * in tests never starts them.
 */
runMigrations()
  .then(() => recoverStaleSyncLocks())
  .then(() => {
    const server = createHttpServer(app, tlsConfig);
    server.listen(serverConfig.port, serverConfig.host, () =>
      console.log(
        `MICD backend listening on ${serverConfig.host ?? "all interfaces"}:${serverConfig.port} (${tlsConfig.enabled ? "https" : "http"})`,
      ),
    );

    // ZEN-02: run the Zenodo health check at startup, then every hour
    checkAllEnvironments().catch((err) =>
      console.error("Zenodo health check failed:", err.message),
    );
    cron.schedule("0 * * * *", () => {
      checkAllEnvironments().catch((err) =>
        console.error("Zenodo health check failed:", err.message),
      );
    });

    // ZEN-10: check every 30 min whether it's time to sync metadata
    cron.schedule("*/30 * * * *", () => {
      shouldRunSync()
        .then((should) => {
          if (should) return runSync();
        })
        .catch((err) => console.error("Zenodo metadata sync failed:", err.message));
    });
  })
  .catch((err) => {
    console.error("Failed to initialize DB:", err);
    process.exit(1);
  });
