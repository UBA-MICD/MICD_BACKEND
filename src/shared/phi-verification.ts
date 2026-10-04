/**
 * Verification that a DICOM instance carries no patient-identifying tag value,
 * run against Orthanc's `/instances/{id}/tags` payload.
 *
 * Why this exists: `studies.anonymized_at` is a *flag*. It records that
 * anonymization was believed to have happened, and anything with database
 * access can set it. Publishing to Zenodo mints a permanent, public DOI, so
 * that path has to look at the data itself rather than trust a column.
 *
 * What "clean" means here is narrow, and callers must not read more into it:
 *
 *  - Only the top-level tags listed below are inspected. Nested sequences are
 *    not walked (the anonymization profile removes them), and private tags are
 *    not enumerated.
 *  - **Pixel data is not inspected at all.** Burned-in annotation survives this
 *    check untouched — see finding H1 in ANONYMIZATION_SECURITY_REVIEW.md.
 *
 * The expectations match the profile the project actually uses
 * (Imagenes-medicas-anonimizacion: DICOM PS3.15 Annex E plus a second pass):
 * names, addresses and phone numbers are blanked or replaced with a
 * placeholder, while identifiers (PatientID, AccessionNumber, StudyID) are
 * replaced by a truncated hash rather than removed.
 */

/** Values an anonymizer may legitimately leave in place of a removed value. */
const PLACEHOLDERS = new Set([
  "",
  "ANONYMIZED",
  "ANONYMOUS",
  "ANONYMOUS^ANONYMOUS",
  "REMOVED",
  "NONE",
  "^^^^",
]);

/**
 * A replaced identifier: a hex digest, not a hospital number or a name.
 *
 * Length alone is not enough, because decimal digits are also hex digits — an
 * 8-digit DNI would otherwise pass as a "hash". So a digest must be at least
 * 16 characters *and* contain a hex letter. A digest that happens to be all
 * digits (~1 in 2000 at 16 chars) is rejected; that direction is the safe one,
 * since it refuses to publish rather than letting an identifier through.
 */
const HASH_LIKE = /^[0-9A-Fa-f]{16,}$/;
const HAS_HEX_LETTER = /[A-Fa-f]/;

/** Placeholder birth dates the profile emits (year 0001 / 1900). */
const PLACEHOLDER_DATE = /^(0001|1900)/;

/** Tags whose value must be blank or a placeholder. */
const MUST_BE_BLANK: ReadonlyArray<[string, string]> = [
  ["0010,0010", "PatientName"],
  ["0010,1000", "OtherPatientIDs"],
  ["0010,1001", "OtherPatientNames"],
  ["0010,1040", "PatientAddress"],
  ["0010,2154", "PatientTelephoneNumbers"],
  ["0010,4000", "PatientComments"],
  ["0008,0080", "InstitutionName"],
  ["0008,0081", "InstitutionAddress"],
  ["0008,0090", "ReferringPhysicianName"],
  ["0008,0092", "ReferringPhysicianAddress"],
  ["0008,0094", "ReferringPhysicianTelephoneNumbers"],
  ["0008,1040", "InstitutionalDepartmentName"],
  ["0008,1048", "PhysiciansOfRecord"],
  ["0008,1050", "PerformingPhysicianName"],
  ["0008,1060", "NameOfPhysiciansReadingStudy"],
  ["0008,1070", "OperatorsName"],
];

/** Identifiers the profile keeps as a hash — never as the original value. */
const MUST_BE_PSEUDONYMIZED: ReadonlyArray<[string, string]> = [
  ["0010,0020", "PatientID"],
  ["0008,0050", "AccessionNumber"],
  ["0020,0010", "StudyID"],
];

const PATIENT_BIRTH_DATE = "0010,0030";
/** PS3.15 De-identification attestation, set by the anonymizer. */
const PATIENT_IDENTITY_REMOVED = "0012,0062";

export interface PhiFinding {
  tag: string;
  name: string;
  reason: string;
}

export interface PhiVerificationResult {
  clean: boolean;
  findings: PhiFinding[];
}

/**
 * Read one tag as a trimmed string. Orthanc returns `{Value: string}` for
 * simple tags and an array for multi-valued ones; a sequence has an array of
 * objects, which is reported as a non-empty value rather than being walked.
 */
function tagValue(tags: Record<string, any>, tag: string): string {
  const raw = tags?.[tag]?.Value;
  if (raw === undefined || raw === null) return "";
  if (Array.isArray(raw)) {
    return raw
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\\")
      .trim();
  }
  return String(raw).trim();
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.toUpperCase().replace(/\0/g, "").trim());
}

/**
 * Inspect an Orthanc tag payload. Returns every identifying value found; an
 * empty `findings` list means none of the inspected tags carried one.
 */
export function verifyInstanceTags(
  tags: Record<string, any>,
): PhiVerificationResult {
  const findings: PhiFinding[] = [];

  for (const [tag, name] of MUST_BE_BLANK) {
    const value = tagValue(tags, tag);
    if (value !== "" && !isPlaceholder(value)) {
      findings.push({ tag, name, reason: "carries a value" });
    }
  }

  for (const [tag, name] of MUST_BE_PSEUDONYMIZED) {
    const value = tagValue(tags, tag);
    if (value === "" || isPlaceholder(value)) continue;
    if (HASH_LIKE.test(value) && HAS_HEX_LETTER.test(value)) continue;
    findings.push({ tag, name, reason: "is not pseudonymized" });
  }

  const birthDate = tagValue(tags, PATIENT_BIRTH_DATE);
  if (birthDate !== "" && !PLACEHOLDER_DATE.test(birthDate)) {
    findings.push({
      tag: PATIENT_BIRTH_DATE,
      name: "PatientBirthDate",
      reason: "is a real date",
    });
  }

  // The attestation is checked last so a file that skipped anonymization
  // entirely reports the concrete tags first, then the missing attestation.
  const attestation = tagValue(tags, PATIENT_IDENTITY_REMOVED).toUpperCase();
  if (attestation !== "YES") {
    findings.push({
      tag: PATIENT_IDENTITY_REMOVED,
      name: "PatientIdentityRemoved",
      reason:
        attestation === ""
          ? "is absent (the instance was never anonymized)"
          : `is "${attestation}", expected "YES"`,
    });
  }

  return { clean: findings.length === 0, findings };
}

/** One-line, PHI-free summary for an error message or an audit entry. */
export function describeFindings(findings: PhiFinding[]): string {
  return findings.map((f) => `${f.name} (${f.tag}) ${f.reason}`).join("; ");
}
