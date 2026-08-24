/**
 * Integration tests for investigador PHI redaction (PR4) against a live backend
 * with sample DICOM. Proves: the studies listing is anonymized for investigador,
 * the patient-name search oracle is closed, and a downloaded DICOM file has its
 * PHI stripped (while medico/admin get the real bytes). Self-skips if the backend
 * is unreachable or there is no sample study.
 */
import axios from "axios";
import { getAuthHeaderFor } from "../helpers/auth";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const bin = { responseType: "arraybuffer" as const, validateStatus: () => true };

let available = false;
let medico: { Authorization: string };
let investigador: { Authorization: string };

// A study with a non-empty patient name, seen through medico eyes (unredacted).
let sample: { id: string; patientName: string } | null = null;

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    available = true;
    medico = await getAuthHeaderFor("medico");
    investigador = await getAuthHeaderFor("investigador");

    const { data } = await axios.get(`${BASE_URL}/api/v1/studies?limit=50`, {
      headers: medico,
    });
    const withName = (data.studies ?? []).find(
      (s: any) => typeof s.patient_name === "string" && s.patient_name.trim().length > 2,
    );
    if (withName) {
      sample = { id: withName.orthanc_study_id, patientName: withName.patient_name };
    }
  } catch {
    console.warn("Backend not reachable — skipping redaction integration tests");
  }
});

describe("metadata redaction", () => {
  it("anonymizes patient identity in the investigador listing", async () => {
    if (!available) return;
    const { data } = await axios.get(`${BASE_URL}/api/v1/studies?limit=50`, {
      headers: investigador,
    });
    for (const s of data.studies ?? []) {
      expect(s.patient_name).toBe("ANONYMIZED");
      if (s.patient_id != null) expect(String(s.patient_id)).toMatch(/^ANON-/);
    }
  });

  it("closes the patient-name search oracle for investigador", async () => {
    if (!available || !sample) return;
    // medico can find the study by patient name...
    const asMedico = await axios.get(
      `${BASE_URL}/api/v1/studies?search=${encodeURIComponent(sample.patientName)}`,
      { headers: medico },
    );
    expect(asMedico.data.total).toBeGreaterThanOrEqual(1);

    // ...investigador's same search is not narrowed by the (blocked) PHI filter.
    const asInvestigador = await axios.get(
      `${BASE_URL}/api/v1/studies?search=${encodeURIComponent(sample.patientName)}`,
      { headers: investigador },
    );
    const all = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers: investigador,
    });
    expect(asInvestigador.data.total).toBe(all.data.total);
  });
});

describe("file download anonymization", () => {
  it("strips PHI from the DICOM an investigador downloads", async () => {
    if (!available || !sample) return;

    const asMedico = await axios.get(
      `${BASE_URL}/api/v1/studies/${sample.id}/file`,
      { headers: medico, ...bin },
    );
    const asInvestigador = await axios.get(
      `${BASE_URL}/api/v1/studies/${sample.id}/file`,
      { headers: investigador, ...bin },
    );

    expect(asMedico.status).toBe(200);
    expect(asInvestigador.status).toBe(200);

    const medBytes = Buffer.from(asMedico.data).toString("latin1");
    const invBytes = Buffer.from(asInvestigador.data).toString("latin1");

    // The real patient name is present for medico, absent for investigador.
    expect(medBytes).toContain(sample.patientName);
    expect(invBytes).not.toContain(sample.patientName);
  });
});
