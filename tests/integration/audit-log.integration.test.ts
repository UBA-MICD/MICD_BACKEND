/**
 * TK-06 — study access is appended to audit_log, the table rejects any
 * UPDATE/DELETE (append-only, "ni siquiera por admin"), and the CSV export
 * stays admin-only. Requires the backend + DB running (self-skips otherwise).
 */
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import { Client } from "pg";
import { dbConfig } from "../../src/config/env";
import { getAuthHeader, getAuthHeaderFor } from "../helpers/auth";

const BASE_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const SAMPLE_DCM = path.resolve(
  __dirname,
  "../fixtures/anonymized-ct.dcm",
);

let backendAvailable = false;
let db: Client;
// Grabbed eagerly in beforeAll — every suite that logs in for real must do so
// before the auth suite's dedicated rate-limit test (which runs 5 deliberately
// failed logins from the same shared IP) has a chance to run; see the
// "Dockerized integration tests" note in CLAUDE.md.
let uploadAuthHeader: { Authorization: string } = { Authorization: "" };

beforeAll(async () => {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
    backendAvailable = true;
  } catch {
    console.warn("Backend not reachable — skipping audit-log integration tests");
    return;
  }
  db = new Client(dbConfig);
  await db.connect();
  uploadAuthHeader = await getAuthHeader();
});

afterAll(async () => {
  await db?.end();
});

/** A well-formed Orthanc-style id (hex groups joined by dashes), unique per call. */
function hexMarker(prefix: string): string {
  return `${prefix}-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
}

/** The middleware logs on res.on("finish"), after the response is sent — poll briefly. */
async function findAuditRow(
  action: string,
  resourceId: string,
  timeoutMs = 3000,
): Promise<{ id: number; user_id: number; ip: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query(
      "SELECT id, user_id, ip FROM audit_log WHERE action = $1 AND resource_id = $2 ORDER BY id DESC LIMIT 1",
      [action, resourceId],
    );
    if (rows[0] || Date.now() > deadline) return rows[0];
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Same as findAuditRow, but for list routes with no single resource id — matched by time instead. */
async function findAuditRowSince(
  action: string,
  resourceId: string,
  sinceIso: string,
  timeoutMs = 3000,
): Promise<{ id: number; user_id: number; ip: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query(
      'SELECT id, user_id, ip FROM audit_log WHERE action = $1 AND resource_id = $2 AND "timestamp" >= $3 ORDER BY id ASC LIMIT 1',
      [action, resourceId, sinceIso],
    );
    if (rows[0] || Date.now() > deadline) return rows[0];
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("TK-06 audit log", () => {
  it("logs STUDY_VIEWED on GET /api/v1/studies (list)", async () => {
    if (!backendAvailable) return;
    const headers = await getAuthHeaderFor("medico");
    const since = new Date(Date.now() - 2000).toISOString();

    const res = await axios.get(`${BASE_URL}/api/v1/studies`, {
      headers,
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);

    const row = await findAuditRowSince("STUDY_VIEWED", "all", since);
    expect(row).toBeDefined();
    expect(row!.ip).toBeTruthy();
  });

  it("does not log a failed/unauthorized request", async () => {
    if (!backendAvailable) return;
    const marker = `tk06-401-${Date.now()}`;
    await axios
      .get(`${BASE_URL}/api/v1/studies/${marker}/instances`, {
        validateStatus: () => true, // no auth header → 401
      })
      .then((res) => expect(res.status).toBe(401));

    const row = await findAuditRow("STUDY_VIEWED", marker, 500);
    expect(row).toBeUndefined();
  });

  it("logs STUDY_DELETED only on a successful delete, not a 404", async () => {
    if (!backendAvailable) return;
    const headers = await getAuthHeaderFor("admin");
    // Well-formed (hex/dash) so it passes id validation and actually reaches
    // Orthanc, which then 404s because the study doesn't exist.
    const marker = hexMarker("deadbeef");
    await axios
      .delete(`${BASE_URL}/api/studies/${marker}`, {
        headers,
        validateStatus: () => true,
      })
      .then((res) => expect(res.status).toBe(404)); // Orthanc: unknown id

    const row = await findAuditRow("STUDY_DELETED", marker, 500);
    expect(row).toBeUndefined();
  });

  it("logs STUDY_UPLOADED with the assigned study id", async () => {
    if (!backendAvailable) return;
    if (!fs.existsSync(SAMPLE_DCM)) {
      console.warn("Sample DICOM not found, skipping");
      return;
    }
    const headers = uploadAuthHeader;
    const form = new FormData();
    form.append("file", fs.createReadStream(SAMPLE_DCM), { filename: "test.dcm" });

    const res = await axios.post(`${BASE_URL}/api/v1/studies/upload`, form, {
      headers: { ...form.getHeaders(), ...headers },
      validateStatus: () => true,
    });
    // 201 first time, 409 duplicate on a re-run — either way a study id exists.
    const studyId =
      res.status === 201
        ? res.data.study.orthanc_study_id
        : res.data.existingStudyId;
    expect(studyId).toBeTruthy();

    const row = await findAuditRow("STUDY_UPLOADED", studyId);
    if (res.status === 201) {
      expect(row).toBeDefined();
    }
  });

  it("rejects UPDATE on audit_log, even as the app's own DB role", async () => {
    if (!backendAvailable) return;
    const { rows } = await db.query("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toBeDefined();
    await expect(
      db.query("UPDATE audit_log SET ip = 'tampered' WHERE id = $1", [rows[0].id]),
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects DELETE on audit_log", async () => {
    if (!backendAvailable) return;
    const { rows } = await db.query("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toBeDefined();
    await expect(
      db.query("DELETE FROM audit_log WHERE id = $1", [rows[0].id]),
    ).rejects.toThrow(/append-only/i);
  });

  it("exports CSV as audit-log.csv, admin only", async () => {
    if (!backendAvailable) return;
    const headers = await getAuthHeaderFor("admin");
    const res = await axios.get(`${BASE_URL}/api/v1/activity/export`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("audit-log.csv");
    expect(res.data).toContain("timestamp,action,result,resource_id,user_id,ip,detail");

    const forbidden = await getAuthHeaderFor("investigador");
    await expect(
      axios.get(`${BASE_URL}/api/v1/activity/export`, { headers: forbidden }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});
