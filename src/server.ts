import cron from "node-cron";
import { app } from "./app";
import { serverConfig } from "./config/env";
import { runMigrations } from "./db/migrate";
import { checkAllEnvironments } from "./modules/zenodo/zenodo.service";

/**
 * Process entry point: apply migrations (which also seed the shared test user)
 * before accepting traffic. If initialization fails the process exits non-zero
 * so the orchestrator can restart it rather than serving from a half-ready
 * state. Background schedulers live here (not in app.ts) so importing the app
 * in tests never starts them.
 */
runMigrations()
  .then(() => {
    app.listen(serverConfig.port, () =>
      console.log(`MICD backend listening on port ${serverConfig.port}`),
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
  })
  .catch((err) => {
    console.error("Failed to initialize DB:", err);
    process.exit(1);
  });
