import { Response } from "express";

/**
 * A domain error carrying the exact HTTP status and JSON body it should
 * produce. Services throw these; controllers translate them to responses via
 * {@link sendError}. This keeps HTTP concerns out of the service layer while
 * still letting services decide the outcome (404 vs 409 vs 503 …).
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null
        ? JSON.stringify(body)
        : String(body),
    );
    this.name = "HttpError";
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

/**
 * Send an error thrown by a service. Known {@link HttpError}s map to their
 * declared status/body; anything else is an unexpected failure → 500.
 */
export function sendError(res: Response, err: unknown): void {
  if (isHttpError(err)) {
    res.status(err.status).json(err.body);
    return;
  }
  res.status(500).json({ error: (err as Error)?.message ?? "Internal error" });
}
