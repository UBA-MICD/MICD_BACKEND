import { app } from "./app";
import { serverConfig } from "./config/env";
import { runMigrations } from "./db/migrate";

/**
 * Process entry point: apply migrations (which also seed the shared test user)
 * before accepting traffic. If initialization fails the process exits non-zero
 * so the orchestrator can restart it rather than serving from a half-ready
 * state.
 */
runMigrations()
  .then(() => {
    app.listen(serverConfig.port, () =>
      console.log(`MICD backend listening on port ${serverConfig.port}`),
    );
  })
  .catch((err) => {
    console.error("Failed to initialize DB:", err);
    process.exit(1);
  });
