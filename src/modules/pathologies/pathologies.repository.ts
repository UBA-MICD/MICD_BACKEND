import { pool } from "../../db/pool";

/** A pathology category: a stable machine `key` and its surrogate id. Human
 *  labels live in the web client, keyed by `key` — never stored here. */
export interface Pathology {
  id: number;
  key: string;
}

/** The whole catalog, ordered by id (the seed order). */
export async function listPathologies(): Promise<Pathology[]> {
  const { rows } = await pool.query<Pathology>(
    "SELECT id, key FROM pathologies ORDER BY id",
  );
  return rows;
}

/** True when `id` is a real catalog row — used to validate an upload's
 *  classification_id before it is stored. */
export async function pathologyExists(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM pathologies WHERE id = $1",
    [id],
  );
  return (rowCount ?? 0) > 0;
}
