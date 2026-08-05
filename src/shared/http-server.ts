import fs from "fs";
import http from "http";
import https from "https";
import { RequestListener } from "http";

export interface TlsConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
}

/**
 * Builds the listener the process actually binds to. TLS is opt-in: when
 * disabled, returns a plain http.Server. When enabled, cert/key paths are
 * required and read eagerly, so a misconfigured deployment fails at startup
 * instead of silently serving plaintext or crashing on the first request.
 */
export function createHttpServer(
  app: RequestListener,
  tls: TlsConfig,
): http.Server | https.Server {
  if (!tls.enabled) {
    return http.createServer(app);
  }

  if (!tls.certPath || !tls.keyPath) {
    throw new Error(
      "TLS_CERT_PATH and TLS_KEY_PATH must be set when TLS_ENABLED=true",
    );
  }

  const cert = fs.readFileSync(tls.certPath);
  const key = fs.readFileSync(tls.keyPath);
  return https.createServer({ cert, key }, app);
}
