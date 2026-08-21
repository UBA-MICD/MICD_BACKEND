/**
 * Unit tests for investigador PHI redaction of study metadata (PR4). Pure logic,
 * no I/O — runs under jest (npm run test:unit).
 */
import {
  redactStudy,
  pseudonymizePatientId,
  mustBlockPatientSearch,
  ANONYMIZED_NAME,
} from "../../../src/modules/studies/study-redaction";

const row = () => ({
  orthanc_study_id: "s1",
  patient_name: "Doe^John",
  patient_id: "PID-12345",
  modality: "CT",
  study_description: "Chest",
  num_instances: 40,
});

describe("redactStudy", () => {
  it.each(["admin", "medico"] as const)("leaves %s rows untouched", (role) => {
    const original = row();
    expect(redactStudy(original, role)).toEqual(original);
  });

  it("blanks the name and pseudonymizes the id for investigador", () => {
    const out = redactStudy(row(), "investigador");
    expect(out.patient_name).toBe(ANONYMIZED_NAME);
    expect(out.patient_id).not.toBe("PID-12345");
    expect(out.patient_id).toMatch(/^ANON-[0-9a-f]{16}$/);
    // research payload passes through untouched
    expect(out.modality).toBe("CT");
    expect(out.study_description).toBe("Chest");
    expect(out.num_instances).toBe(40);
  });

  it("does not mutate the input row", () => {
    const original = row();
    redactStudy(original, "investigador");
    expect(original.patient_name).toBe("Doe^John");
    expect(original.patient_id).toBe("PID-12345");
  });

  it("leaves a null patient_id as null (nothing to pseudonymize)", () => {
    const out = redactStudy({ patient_name: "X", patient_id: null }, "investigador");
    expect(out.patient_id).toBeNull();
    expect(out.patient_name).toBe(ANONYMIZED_NAME);
  });

  it("tolerates rows missing patient fields", () => {
    expect(() => redactStudy({ modality: "MR" }, "investigador")).not.toThrow();
  });
});

describe("pseudonymizePatientId", () => {
  it("is deterministic per id and differs across ids", () => {
    expect(pseudonymizePatientId("a")).toBe(pseudonymizePatientId("a"));
    expect(pseudonymizePatientId("a")).not.toBe(pseudonymizePatientId("b"));
  });

  it("never contains the original id", () => {
    expect(pseudonymizePatientId("PID-12345")).not.toContain("PID-12345");
  });
});

describe("mustBlockPatientSearch", () => {
  it("blocks investigador only", () => {
    expect(mustBlockPatientSearch("investigador")).toBe(true);
    expect(mustBlockPatientSearch("admin")).toBe(false);
    expect(mustBlockPatientSearch("medico")).toBe(false);
  });
});
