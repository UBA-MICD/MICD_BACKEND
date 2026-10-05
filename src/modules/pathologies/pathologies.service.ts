import * as repo from "./pathologies.repository";
import type { Pathology } from "./pathologies.repository";

/** Business layer for the pathology catalog. Thin today (the catalog is a
 *  static lookup), but it keeps controllers and other services off the
 *  repository so the layering stays controller -> service -> repository. */

/** The whole catalog, ordered by id. */
export function listPathologies(): Promise<Pathology[]> {
  return repo.listPathologies();
}

/** Whether `id` is a real catalog row (used to validate an upload). */
export function pathologyExists(id: number): Promise<boolean> {
  return repo.pathologyExists(id);
}
