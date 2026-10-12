import { HttpError } from "../../shared/http-error";

/**
 * Parse the optional `classification_id` upload form field. Returns the
 * positive-integer catalog id, or null when absent/blank. Throws HttpError 400
 * when it is present but not a positive integer — so an upload can never carry
 * free text. Whether the id actually exists in the catalog is a separate DB
 * check (see upload.service / pathologies.service).
 */
export function parseClassificationId(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n <= 0) {
    throw new HttpError(400, {
      error: "classification_id must be a positive integer",
    });
  }
  return n;
}
