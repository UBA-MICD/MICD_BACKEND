/**
 * Unit tests for upload.service — DICOM ingestion flow, validation, duplicate
 * handling, and error mapping. Orthanc client and the upload repository are
 * mocked; no live PACS or DB required.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../../src/clients/orthanc.client", () => ({
  orthancClient: {
    postInstance: jest.fn(),
    getInstanceTags: jest.fn(),
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

const SAMPLE_TAGS = {
  "0008,0018": { Value: "1.2.3.4.5" }, // SOP Instance UID
  "0020,000d": { Value: "1.2.3.study" }, // Study Instance UID
  "0010,0010": { Value: "Doe^John" }, // Patient Name
  "0010,0020": { Value: "PID-001" }, // Patient ID
  "0008,0020": { Value: "20240101" }, // Study Date
  "0008,1030": { Value: "Chest CT" }, // Study Description
  "0008,0060": { Value: "CT" }, // Modality
  "0020,0013": { Value: [1] }, // Instance Number
  "0028,0010": { Value: [512] }, // Rows
  "0028,0011": { Value: [512] }, // Cols
  "0008,103e": { Value: "Axial Brain" }, // Series Description (TK-12)
  "0020,1208": { Value: [200] }, // Number of Study Related Images (TK-12)
};

const STUDY_ROW = {
  id: 1,
  orthanc_study_id: "study-xyz",
  sop_instance_uid: "1.2.3.4.5",
};

// ── common setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  orthancClient.postInstance.mockResolvedValue({
    data: ORTHANC_SUCCESS_RESPONSE,
  });
  orthancClient.getInstanceTags.mockResolvedValue({ data: SAMPLE_TAGS });
  mockRepo.upsertStudy.mockResolvedValue(STUDY_ROW);
  mockRepo.findBySopInstanceUid.mockResolvedValue(undefined);
  mockRepo.deleteBySopInstanceUid.mockResolvedValue(undefined);
});

// ── file validation ───────────────────────────────────────────────────────────

describe("uploadDicom — file validation", () => {
  it("throws 413 when the file exceeds the maximum allowed size", async () => {
    // MAX_FILE_SIZE defaults to 500 MB; we send size = MAX+1
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
  it("posts the file buffer to Orthanc", async () => {
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

// ── DICOM tag extraction & metadata persistence ───────────────────────────────

describe("uploadDicom — metadata extraction and persistence", () => {
  it("upserts study metadata with the tags fetched from Orthanc", async () => {
    const result = await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({
        orthancStudyId: "study-xyz",
        orthancInstanceId: "inst-abc",
        sopInstanceUid: "1.2.3.4.5",
        studyInstanceUid: "1.2.3.study",
        patientName: "Doe^John",
        patientId: "PID-001",
        modality: "CT",
      }),
    );
    expect(result.study).toEqual(STUDY_ROW);
    expect(result.orthanc).toEqual(ORTHANC_SUCCESS_RESPONSE);
  });

  it("falls back to modality 'OTHER' when the DICOM tag is absent", async () => {
    const tagsWithoutModality = { ...SAMPLE_TAGS };
    delete (tagsWithoutModality as any)["0008,0060"];
    orthancClient.getInstanceTags.mockResolvedValue({
      data: tagsWithoutModality,
    });

    await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ modality: "OTHER" }),
    );
  });

  it("still upserts when Orthanc's tag endpoint fails (non-fatal)", async () => {
    orthancClient.getInstanceTags.mockRejectedValue(
      new Error("tags unavailable"),
    );

    // Should not throw
    await expect(uploadDicom(SMALL_FILE, false)).resolves.toHaveProperty(
      "orthanc",
    );
    expect(mockRepo.upsertStudy).toHaveBeenCalled();
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

// ── duplicate handling ────────────────────────────────────────────────────────

describe("uploadDicom — duplicate handling", () => {
  it("throws 409 when Orthanc says AlreadyStored and force=false", async () => {
    orthancClient.postInstance.mockResolvedValue({
      data: ORTHANC_ALREADY_STORED_RESPONSE,
    });
    mockRepo.findBySopInstanceUid.mockResolvedValue({
      id: 1,
      orthanc_study_id: "study-xyz",
    });

    let caught: unknown;
    try {
      await uploadDicom(SMALL_FILE, false);
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(409);
  });

  it("includes the existing study id and sopInstanceUid in the 409 body", async () => {
    orthancClient.postInstance.mockResolvedValue({
      data: ORTHANC_ALREADY_STORED_RESPONSE,
    });
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
    expect(caught?.body?.error).toBe("duplicate");
    expect(caught?.body?.existingStudyId).toBe("study-xyz");
  });

  it("with force=true, deletes the existing record then upserts", async () => {
    orthancClient.postInstance.mockResolvedValue({
      data: ORTHANC_ALREADY_STORED_RESPONSE,
    });
    mockRepo.findBySopInstanceUid.mockResolvedValue({
      id: 1,
      orthanc_study_id: "study-xyz",
    });

    const result = await uploadDicom(SMALL_FILE, true);

    expect(mockRepo.deleteBySopInstanceUid).toHaveBeenCalledWith("1.2.3.4.5");
    expect(mockRepo.upsertStudy).toHaveBeenCalled();
    expect(result.study).toEqual(STUDY_ROW);
  });

  it("with force=true and no existing DB record, skips delete and upserts normally", async () => {
    orthancClient.postInstance.mockResolvedValue({
      data: ORTHANC_ALREADY_STORED_RESPONSE,
    });
    mockRepo.findBySopInstanceUid.mockResolvedValue(undefined);

    await uploadDicom(SMALL_FILE, true);

    expect(mockRepo.deleteBySopInstanceUid).toHaveBeenCalled();
    expect(mockRepo.upsertStudy).toHaveBeenCalled();
  });

  it("does not call deleteBySopInstanceUid when Orthanc reports Success (not a duplicate)", async () => {
    // postInstance is already set to return Status=Success in beforeEach
    await uploadDicom(SMALL_FILE, false);
    expect(mockRepo.deleteBySopInstanceUid).not.toHaveBeenCalled();
  });
});

// ── TK-12: series_description + number_of_images extraction ──────────────────

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

  it("stores seriesDescription as empty string when tag 0008,103e is absent", async () => {
    const tagsWithout = { ...SAMPLE_TAGS } as any;
    delete tagsWithout["0008,103e"];
    orthancClient.getInstanceTags.mockResolvedValue({ data: tagsWithout });

    await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ seriesDescription: "" }),
    );
  });

  it("stores numberOfImages as null when tag 0020,1208 is absent", async () => {
    const tagsWithout = { ...SAMPLE_TAGS } as any;
    delete tagsWithout["0020,1208"];
    orthancClient.getInstanceTags.mockResolvedValue({ data: tagsWithout });

    await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ numberOfImages: null }),
    );
  });

  it("stores both as empty/null when Orthanc tag endpoint fails", async () => {
    orthancClient.getInstanceTags.mockRejectedValue(
      new Error("tags unavailable"),
    );

    await uploadDicom(SMALL_FILE, false);

    expect(mockRepo.upsertStudy).toHaveBeenCalledWith(
      expect.objectContaining({ seriesDescription: "", numberOfImages: null }),
    );
  });
});
