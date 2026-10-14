/**
 * Unit tests for upload.service — DICOM ingestion flow, validation, duplicate
 * handling, error mapping, and the TK-11 pre-storage PHI check (strict/warn).
 * Orthanc client and the upload repository are mocked; no live PACS or DB.
 */
import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../../../src/clients/orthanc.client", () => ({
  orthancClient: {
    postInstance: jest.fn(),
    getInstanceTags: jest.fn(),
    deleteInstance: jest.fn(),
  },
}));

jest.mock("../../../src/modules/upload/upload.repository");

import * as repo from "../../../src/modules/upload/upload.repository";
import { uploadDicom } from "../../../src/modules/upload/upload.service";
import { isHttpError } from "../../../src/shared/http-error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { orthancClient } = jest.requireMock(
  "../../../src/clients/orthanc.client",
) as any;
const mockRepo = repo as jest.Mocked<typeof repo>;

// ── fixtures ──────────────────────────────────────────────────────────────────

const SMALL_BUFFER = Buffer.alloc(100, 0);
const SMALL_FILE = { buffer: SMALL_BUFFER, size: 100 };

const ORTHANC_SUCCESS_RESPONSE = {
  ID: "inst-abc",
  ParentStudy: "study-xyz",
  Status: "Success",
};

const ORTHANC_ALREADY_STORED_RESPONSE = {
  ID: "inst-abc",
  ParentStudy: "study-xyz",
  Status: "AlreadyStored",
};

/** Non-identifying tags common to every fixture. */
const BASE_TAGS = {
  "0008,0018": { Value: "1.2.3.4.5" }, // SOP Instance UID
  "0020,000d": { Value: "1.2.3.study" }, // Study Instance UID
  "0008,0020": { Value: "20240101" }, // Study Date
  "0008,1030": { Value: "Chest CT" }, // Study Description
  "0008,0060": { Value: "CT" }, // Modality (not risky)
  "0020,0013": { Value: [1] }, // Instance Number
  "0028,0010": { Value: [512] }, // Rows
  "0028,0011": { Value: [512] }, // Cols
  "0008,103e": { Value: "Axial Brain" }, // Series Description (TK-12)
  "0020,1208": { Value: [200] }, // Number of Study Related Images (TK-12)
};

/** What the project anonymizer produces: blanked name, hashed id, attestation. */
const ANONYMIZED_TAGS = {
  ...BASE_TAGS,
  "0010,0010": { Value: "" }, // Patient Name blanked
  "0010,0020": { Value: "A1B2C3D4E5F60718" }, // Patient ID hashed
  "0012,0062": { Value: "YES" }, // PatientIdentityRemoved
};

/** A raw instance that still carries identifying values. */
const RAW_TAGS = {
  ...BASE_TAGS,
  "0010,0010": { Value: "Doe^John" }, // Patient Name
  "0010,0020": { Value: "PID-001" }, // Patient ID (not pseudonymized)
  "0010,0030": { Value: "19800101" }, // real Patient Birth Date
  // no attestation — the instance was never anonymized
};

const STUDY_ROW = {
  id: 1,
  orthanc_study_id: "study-xyz",
  sop_instance_uid: "1.2.3.4.5",
};

// ── common setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ANONYMIZATION_VERIFY_MODE; // default: strict
  orthancClient.postInstance.mockResolvedValue({
    data: ORTHANC_SUCCESS_RESPONSE,
  });
  orthancClient.getInstanceTags.mockResolvedValue({ data: ANONYMIZED_TAGS });
  orthancClient.deleteInstance.mockResolvedValue({ data: {} });
  mockRepo.upsertStudy.mockResolvedValue(STUDY_ROW);
  mockRepo.findBySopInstanceUid.mockResolvedValue(undefined);
  mockRepo.deleteBySopInstanceUid.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.ANONYMIZATION_VERIFY_MODE;
});

// ── file validation ───────────────────────────────────────────────────────────

describe("uploadDicom — file validation", () => {
  it("throws 413 when the file exceeds the maximum allowed size", async () => {
    const MAX = 500 * 1024 * 1024;
    const oversized = { buffer: Buffer.alloc(1), size: MAX + 1 };

    let caught: unknown;
    try {
      await uploadDicom(oversized, false);
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(413);
    expect(orthancClient.postInstance).not.toHaveBeenCalled();
  });

  it("accepts a file exactly at the size limit", async () => {
    const MAX = 500 * 1024 * 1024;
    const atLimit = { buffer: Buffer.alloc(1), size: MAX };

    const result = await uploadDicom(atLimit, false);
    expect(orthancClient.postInstance).toHaveBeenCalled();
    expect(result).toHaveProperty("orthanc");
  });
});

// ── Orthanc interaction ───────────────────────────────────────────────────────

describe("uploadDicom — Orthanc upload", () => {
  it("posts the received buffer to Orthanc (anonymization is client-side)", async () => {
    await uploadDicom(SMALL_FILE, false);
    expect(orthancClient.postInstance).toHaveBeenCalledWith(SMALL_BUFFER);
  });

  it("throws 400 when Orthanc rejects the file as invalid DICOM", async () => {
    const err: any = new Error("Bad Request");
    err.response = { status: 400, data: {} };
    orthancClient.postInstance.mockRejectedValue(err);

    let caught: unknown;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (e) {
      caught = e;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(400);
  });

  it("throws 503 when Orthanc is unreachable", async () => {
    orthancClient.postInstance.mockRejectedValue(new Error("ECONNREFUSED"));

    let caught: unknown;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(503);
  });
});

// ── DICOM tag extraction & metadata persistence (anonymized instance) ──────────

describe("uploadDicom — metadata extraction and persistence", () => {
  it("upserts study metadata and marks a clean instance anonymized", async () => {
    const result = await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({
        orthancStudyId: "study-xyz",
        orthancInstanceId: "inst-abc",
        sopInstanceUid: "1.2.3.4.5",
        studyInstanceUid: "1.2.3.study",
        modality: "CT",
        needsReview: false,
        anonymizedAt: expect.any(Date),
      }),
    );
    expect(result.study).toEqual(STUDY_ROW);
    expect(result.orthanc).toEqual(ORTHANC_SUCCESS_RESPONSE);
    expect(result.verification).toEqual({ needsReview: false, findings: [] });
    expect(orthancClient.deleteInstance).not.toHaveBeenCalled();
  });

  it("falls back to modality 'OTHER' when the DICOM tag is absent", async () => {
    const tags = { ...ANONYMIZED_TAGS };
    delete (tags as any)["0008,0060"];
    orthancClient.getInstanceTags.mockResolvedValue({ data: tags });

    await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ modality: "OTHER" }),
    );
  });

  it("throws 500 when the DB upsert fails", async () => {
    mockRepo.upsertStudy.mockRejectedValue(new Error("DB down"));

    let caught: unknown;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(500);
  });
});

// ── duplicate handling (anonymized instance passes the check first) ────────────

describe("uploadDicom — duplicate handling", () => {
  beforeEach(() => {
    orthancClient.postInstance.mockResolvedValue({
      data: ORTHANC_ALREADY_STORED_RESPONSE,
    });
  });

  it("throws 409 when Orthanc says AlreadyStored and force=false", async () => {
    mockRepo.findBySopInstanceUid.mockResolvedValue({
      id: 1,
      orthanc_study_id: "study-xyz",
    });

    let caught: any;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect(caught.status).toBe(409);
    expect(caught.body?.error).toBe("duplicate");
    expect(caught.body?.existingStudyId).toBe("study-xyz");
  });

  it("with force=true, deletes the existing record then upserts", async () => {
    mockRepo.findBySopInstanceUid.mockResolvedValue({
      id: 1,
      orthanc_study_id: "study-xyz",
    });

    const result = await uploadDicom(SMALL_FILE, true);

    expect(mockRepo.deleteBySopInstanceUid).toHaveBeenCalledWith("1.2.3.4.5");
    expect(mockRepo.upsertStudy).toHaveBeenCalled();
    expect(result.study).toEqual(STUDY_ROW);
  });

  it("does not delete the DB record when Orthanc reports Success", async () => {
    orthancClient.postInstance.mockResolvedValue({
      data: ORTHANC_SUCCESS_RESPONSE,
    });
    await uploadDicom(SMALL_FILE, false);
    expect(mockRepo.deleteBySopInstanceUid).not.toHaveBeenCalled();
  });
});

// ── TK-12: series_description + number_of_images extraction ────────────────────

describe("uploadDicom — TK-12 metadata (series_description, number_of_images)", () => {
  it("forwards seriesDescription and numberOfImages to upsertStudy", async () => {
    await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({
        seriesDescription: "Axial Brain",
        numberOfImages: 200,
      }),
    );
  });

  it("stores seriesDescription empty / numberOfImages null when absent", async () => {
    const tags = { ...ANONYMIZED_TAGS } as any;
    delete tags["0008,103e"];
    delete tags["0020,1208"];
    orthancClient.getInstanceTags.mockResolvedValue({ data: tags });

    await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ seriesDescription: "", numberOfImages: null }),
    );
  });
});

// ── TK-11: strict mode (default) ───────────────────────────────────────────────

describe("uploadDicom — TK-11 strict mode", () => {
  beforeEach(() => {
    orthancClient.getInstanceTags.mockResolvedValue({ data: RAW_TAGS });
  });

  it("rejects residual PII with 422, deletes from Orthanc, stores nothing", async () => {
    let caught: any;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(422);
    expect(caught.body.error).toBe("not_anonymized");
    // The offending tags are named...
    const names = caught.body.tags.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["PatientName", "PatientID", "PatientBirthDate"]),
    );
    // ...and cleanup + no persistence happened.
    expect(orthancClient.deleteInstance).toHaveBeenCalledWith("inst-abc");
    expect(mockRepo.upsertStudy).not.toHaveBeenCalled();
  });

  it("never leaks tag values into the 422 body (names/reasons only)", async () => {
    let caught: any;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (err) {
      caught = err;
    }
    const serialized = JSON.stringify(caught.body);
    expect(serialized).not.toContain("Doe^John");
    expect(serialized).not.toContain("PID-001");
    expect(serialized).not.toContain("19800101");
  });

  it("never logs tag values", async () => {
    const logged: string[] = [];
    const spyLog = jest
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    const spyErr = jest
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));

    await uploadDicom(SMALL_FILE, false).catch(() => {});

    const all = logged.join("\n");
    expect(all).not.toContain("Doe^John");
    expect(all).not.toContain("PID-001");
    spyLog.mockRestore();
    spyErr.mockRestore();
  });

  it("fails closed when tags cannot be read (verifier can't confirm)", async () => {
    orthancClient.getInstanceTags.mockRejectedValue(new Error("tags down"));

    let caught: any;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(422);
    expect(orthancClient.deleteInstance).toHaveBeenCalledWith("inst-abc");
    expect(mockRepo.upsertStudy).not.toHaveBeenCalled();
  });

  it("stores a clean-but-burned-in instance, flagged for review", async () => {
    orthancClient.getInstanceTags.mockResolvedValue({
      data: { ...ANONYMIZED_TAGS, "0028,0301": { Value: "YES" } },
    });

    const result = await uploadDicom(SMALL_FILE, false);

    expect(orthancClient.deleteInstance).not.toHaveBeenCalled();
    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ needsReview: true }),
    );
    expect(result.verification.needsReview).toBe(true);
    expect(result.verification.findings[0].name).toBe("BurnedInAnnotation");
  });
});

// ── TK-11: warn mode ───────────────────────────────────────────────────────────

describe("uploadDicom — TK-11 warn mode", () => {
  beforeEach(() => {
    process.env.ANONYMIZATION_VERIFY_MODE = "warn";
    orthancClient.getInstanceTags.mockResolvedValue({ data: RAW_TAGS });
  });

  it("stores residual PII but flags needs_review (no delete, no block)", async () => {
    const result = await uploadDicom(SMALL_FILE, false);

    expect(orthancClient.deleteInstance).not.toHaveBeenCalled();
    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({
        needsReview: true,
        anonymizedAt: null,
        reviewFindings: expect.arrayContaining([
          expect.objectContaining({ name: "PatientName", severity: "error" }),
        ]),
      }),
    );
    expect(result.verification.needsReview).toBe(true);
  });

  it("stores flagged-as-unverified when tags cannot be read", async () => {
    orthancClient.getInstanceTags.mockRejectedValue(new Error("tags down"));

    const result = await uploadDicom(SMALL_FILE, false);

    expect(orthancClient.deleteInstance).not.toHaveBeenCalled();
    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ needsReview: true, anonymizedAt: null }),
    );
    expect(result.verification.needsReview).toBe(true);
  });

  it("the review findings never carry tag values", async () => {
    await uploadDicom(SMALL_FILE, false);
    const arg: any = mockRepo.upsertStudy.mock.calls[0][0];
    expect(JSON.stringify(arg.reviewFindings)).not.toContain("Doe^John");
  });
});
