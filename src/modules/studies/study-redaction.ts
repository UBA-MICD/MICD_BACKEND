import { createHash } from "crypto";
import { Role } from "../../shared/roles";

/**
 * Investigador PHI redaction for study metadata (US-21). Pure and I/O-free so it
 * unit-tests cheaply and can wrap every row a study query returns.
 *
 * An investigador sees the research payload (modality, description, dates, counts,
 * Zenodo links) but never patient identity: `patient_name` is blanked and
 * `patient_id` is replaced by a deterministic pseudonym so studies stay groupable
 * per subject without carrying the real id. admin and medico see rows unchanged.
 */

export const ANONYMIZED_NAME = "ANONYMIZED";

/** A stable, non-reversible pseudonym for a patient id (same id → same token). */
export function pseudonymizePatientId(patientId: string): string {
  return `ANON-${createHash("sha256").update(patientId).digest("hex").slice(0, 16)}`;
}

/**
 * Redact one study row for `role`. Returns the row unchanged for admin/medico;
 * for investigador returns a shallow copy with patient identity removed. Only
 * fields that are present are touched, so it is safe over both `findStudies` and
 * `findStudyZenodoMeta` shapes.
 */
export function redactStudy<T extends Record<string, unknown>>(
  row: T,
  role: Role,
): T {
  if (role !== "investigador") return row;

  const redacted: Record<string, unknown> = { ...row };
  if ("patient_name" in redacted) {
    redacted.patient_name = ANONYMIZED_NAME;
  }
  if ("patient_id" in redacted && redacted.patient_id != null) {
    redacted.patient_id = pseudonymizePatientId(String(redacted.patient_id));
  }
  return redacted as T;
}

/** True when this role must not drive a patient-name/id search (PHI oracle). */
export function mustBlockPatientSearch(role: Role): boolean {
  return role === "investigador";
}
