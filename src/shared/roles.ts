/**
 * The RBAC role vocabulary — the single source of truth reused by the role
 * migration, the `requireRole` middleware, the JWT payload, the OpenAPI spec
 * and the tests. Keeping the tuple here (rather than re-declaring the three
 * strings in each place) means adding or renaming a role is one edit.
 *
 * - `admin`        — full access, including user management and publication.
 * - `medico`       — clinical read + write on studies; no user management.
 * - `investigador` — read-only, PHI-free; no writes, no external publication.
 */
export const ROLES = ["admin", "medico", "investigador"] as const;

export type Role = (typeof ROLES)[number];

/** Runtime type guard: true iff `x` is one of the three known role strings. */
export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as readonly string[]).includes(x);
}
