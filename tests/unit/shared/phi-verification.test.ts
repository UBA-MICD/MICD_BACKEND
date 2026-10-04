import {
  describeFindings,
  verifyInstanceTags,
} from "../../../src/shared/phi-verification";

/** Orthanc's /tags shape: { "gggg,eeee": { Value: ... } }. */
const tag = (pairs: Record<string, unknown>): Record<string, any> =>
  Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, { Value: v }]));

/**
 * What the project's anonymization profile actually produces: names blanked,
 * institution replaced with a placeholder, identifiers hashed, birth date
 * zeroed, and the PS3.15 attestation set.
 */
const ANONYMIZED = tag({
  "0010,0010": "",
  "0010,0020": "A1B2C3D4E5F60718",
  "0010,0030": "00010101",
  "0008,0050": "18D82379CF5D1692",
  "0008,0080": "ANONYMIZED",
  "0012,0062": "YES",
});

describe("verifyInstanceTags", () => {
  it("accepts an instance anonymized by the project profile", () => {
    expect(verifyInstanceTags(ANONYMIZED)).toEqual({
      clean: true,
      findings: [],
    });
  });

  it("rejects a raw instance and names every identifying tag", () => {
    const raw = tag({
      "0010,0010": "Pérez^José",
      "0010,0020": "30111222",
      "0010,0030": "19750612",
      "0008,0080": "Hospital de Clínicas",
      "0008,0090": "Dr. Gómez",
    });

    const { clean, findings } = verifyInstanceTags(raw);

    expect(clean).toBe(false);
    const names = findings.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "PatientName",
        "PatientID",
        "PatientBirthDate",
        "InstitutionName",
        "ReferringPhysicianName",
        "PatientIdentityRemoved",
      ]),
    );
  });

  it("rejects an instance with no tags at all", () => {
    // An empty payload has nothing identifying in it, but it also carries no
    // attestation — "unknown" must fail closed, not pass.
    const { clean, findings } = verifyInstanceTags({});
    expect(clean).toBe(false);
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe("PatientIdentityRemoved");
  });

  it("rejects an all-digit id, which is hex-shaped but is really a DNI/MRN", () => {
    // 8 decimal digits are also 8 hex digits — the check must not mistake an
    // Argentine DNI for a digest.
    const { findings } = verifyInstanceTags({
      ...ANONYMIZED,
      ...tag({ "0010,0020": "30111222" }),
    });
    expect(findings).toEqual([
      expect.objectContaining({ name: "PatientID", reason: "is not pseudonymized" }),
    ]);
  });

  it("rejects a PatientID that was never pseudonymized", () => {
    const { findings } = verifyInstanceTags({
      ...ANONYMIZED,
      ...tag({ "0010,0020": "MRN-44182" }),
    });
    expect(findings).toEqual([
      expect.objectContaining({ name: "PatientID", reason: "is not pseudonymized" }),
    ]);
  });

  it("accepts a blank or placeholder identifier as well as a hash", () => {
    for (const value of ["", "ANONYMIZED", "A1B2C3D4E5F60718"]) {
      const result = verifyInstanceTags({
        ...ANONYMIZED,
        ...tag({ "0010,0020": value }),
      });
      expect(result.clean).toBe(true);
    }
  });

  it("rejects a real birth date but accepts the placeholder years", () => {
    expect(
      verifyInstanceTags({ ...ANONYMIZED, ...tag({ "0010,0030": "19750612" }) }).clean,
    ).toBe(false);
    for (const value of ["", "00010101", "19000101"]) {
      expect(
        verifyInstanceTags({ ...ANONYMIZED, ...tag({ "0010,0030": value }) }).clean,
      ).toBe(true);
    }
  });

  it("rejects an attestation that is present but not YES", () => {
    const { findings } = verifyInstanceTags({
      ...ANONYMIZED,
      ...tag({ "0012,0062": "NO" }),
    });
    expect(findings).toEqual([
      expect.objectContaining({ name: "PatientIdentityRemoved" }),
    ]);
    expect(findings[0].reason).toContain("NO");
  });

  it("reads multi-valued tags, so PHI in any element is caught", () => {
    const { clean, findings } = verifyInstanceTags({
      ...ANONYMIZED,
      ...tag({ "0010,1001": ["", "Pérez^María"] }),
    });
    expect(clean).toBe(false);
    expect(findings[0].name).toBe("OtherPatientNames");
  });

  it("treats a sequence left in a name tag as a value", () => {
    const { clean } = verifyInstanceTags({
      ...ANONYMIZED,
      "0010,1001": { Value: [{ "0010,0010": { Value: "Pérez^María" } }] },
    });
    expect(clean).toBe(false);
  });
});

describe("describeFindings", () => {
  it("reports tag names and reasons, never the offending values", () => {
    const { findings } = verifyInstanceTags(
      tag({ "0010,0010": "Pérez^José", "0010,0020": "30111222" }),
    );
    const text = describeFindings(findings);

    expect(text).toContain("PatientName (0010,0010)");
    expect(text).toContain("PatientID (0010,0020)");
    // The description travels into HTTP responses and audit rows, so it must
    // not reintroduce the PHI it is reporting on.
    expect(text).not.toContain("Pérez");
    expect(text).not.toContain("30111222");
  });
});
