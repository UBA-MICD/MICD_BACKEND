import dicomParser from "dicom-parser";

/**
 * Independent, defense-in-depth check that the anonymizer actually stripped the
 * patient-identifying tags before we let a DICOM reach Orthanc (US-16, AC1).
 *
 * This does NOT trust the module's word for it: it re-parses the returned bytes
 * and compares the four critical tags against the original upload. A tag counts
 * as a leak only if it still carries the *original clear-text value* — the
 * module legitimately keeps PatientID as a deterministic hash, so "changed or
 * removed" is the pass condition, not "empty". As a positive gate we also
 * require the module's `PatientIdentityRemoved = YES` marker: if it is missing,
 * anonymization did not really run and we fail closed.
 *
 * Pure and synchronous (dicom-parser is sync) so it is cheap to unit-test.
 */

// dicom-parser tag keys are "xggggeeee" (group+element, lower-case hex).
const TAG = {
  PatientName: "x00100010",
  PatientID: "x00100020",
  PatientBirthDate: "x00100030",
  InstitutionName: "x00080080",
  PatientIdentityRemoved: "x00120062",
} as const;

/** The four tags AC1 requires to never appear in clear text in Orthanc. */
export const CRITICAL_TAGS = [
  "PatientName",
  "PatientID",
  "PatientBirthDate",
  "InstitutionName",
] as const;

export interface ValidationResult {
  ok: boolean;
  /** Critical tags that still hold their original clear-text value. */
  leaked: string[];
  /** Whether the module marked the dataset as de-identified. */
  marked: boolean;
}

function tagValue(dataSet: dicomParser.DataSet, tag: string): string {
  try {
    return (dataSet.string(tag) ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Validate an anonymized DICOM against its original. Throws if either buffer
 * cannot be parsed as DICOM — the caller treats that as a fail-closed rejection.
 */
export function validateAnonymized(
  anonymized: Buffer,
  original: Buffer,
): ValidationResult {
  const anon = dicomParser.parseDicom(anonymized);
  const orig = dicomParser.parseDicom(original);

  const leaked: string[] = [];
  for (const name of CRITICAL_TAGS) {
    const tag = TAG[name];
    const before = tagValue(orig, tag);
    const after = tagValue(anon, tag);
    // Only a concern if the original actually held something identifiable and
    // the anonymized copy still carries that exact clear-text value.
    if (before && after === before) {
      leaked.push(name);
    }
  }

  const marked =
    tagValue(anon, TAG.PatientIdentityRemoved).toUpperCase() === "YES";

  return { ok: leaked.length === 0 && marked, leaked, marked };
}
