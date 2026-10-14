/**
 * Unit tests for studies.service — listing/filtering, retrieval, pagination,
 * and PHI redaction integration.  Orthanc client and the repository are mocked;
 * no live DB or PACS required.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../../src/clients/orthanc.client", () => ({
  orthancClient: {
    listStudies: jest.fn(),
    getStudy: jest.fn(),
    deleteStudy: jest.fn(),
    getInstanceFile: jest.fn(),
    anonymizeInstance: jest.fn(),
    getInstancePreview: jest.fn(),
    postInstance: jest.fn(),
    getInstanceTags: jest.fn(),
  },
}));

jest.mock("../../../src/modules/studies/studies.repository");
jest.mock("../../../src/clients/zenodo.client", () => ({
  zenodoClient: {
    getRecord: jest.fn(),
    searchRecords: jest.fn(),
  },
}));
jest.mock("../../../src/modules/zenodo/zenodo-search.service");
jest.mock("../../../src/modules/zenodo/zenodo.service");
jest.mock("../../../src/modules/zenodo/zenodo-sync.service");
jest.mock("../../../src/shared/audit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AUDIT_ACTIONS: (jest.requireActual("../../../src/shared/audit") as any)
    .AUDIT_ACTIONS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logAction: (jest.fn() as any).mockResolvedValue(null),
}));

import * as repo from "../../../src/modules/studies/studies.repository";
import {
  listStudies,
  getStudyDicomFile,
  getStudyInstances,
  getInstanceDicomFile,
  getStudyThumbnail,
} from "../../../src/modules/studies/studies.service";
import { StudyFilters } from "../../../src/modules/studies/studies.repository";
import { isHttpError } from "../../../src/shared/http-error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { orthancClient } = jest.requireMock(
  "../../../src/clients/orthanc.client",
) as any;
const mockRepo = repo as jest.Mocked<typeof repo>;

// ── fixtures ──────────────────────────────────────────────────────────────────

const EMPTY_FILTERS: StudyFilters = {
  modality: null,
  dateFrom: null,
  dateTo: null,
  search: null,
  zenodoLinked: null,
  description: null,
  validationStatus: null,
};

const makeStudyRow = (over: Record<string, unknown> = {}) => ({
  orthanc_study_id: "study-1",
  patient_name: "Doe^John",
  patient_id: "PID-001",
  modality: "CT",
  study_description: "Chest",
  study_date: "20240101",
  uploaded_at: new Date("2024-01-01"),
  num_instances: 3,
  zenodo_doi: null,
  zenodo_published_at: null,
  zenodo_source_record_id: null,
  zenodo_source_doi: null,
  zenodo_imported_at: null,
  zenodo_new_version_available: null,
  ...over,
});

const INSTANCE_ROWS = [
  { id: 1, orthanc_instance_id: "inst-1", instance_number: 1 },
  { id: 2, orthanc_instance_id: "inst-2", instance_number: 2 },
];

// ── common setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.countStudies.mockResolvedValue(0);
  mockRepo.findStudies.mockResolvedValue([]);
  mockRepo.findFirstInstanceId.mockResolvedValue("inst-1");
  mockRepo.findInstances.mockResolvedValue(INSTANCE_ROWS);
  mockRepo.instanceExists.mockResolvedValue(true);
  orthancClient.getInstanceFile.mockResolvedValue({
    data: Buffer.from("dicom"),
  });
  orthancClient.anonymizeInstance.mockResolvedValue({
    data: Buffer.from("anon-dicom"),
  });
  orthancClient.getInstancePreview.mockResolvedValue({
    data: Buffer.from("jpeg"),
    headers: { "content-type": "image/jpeg" },
  });
});

// ── listStudies ───────────────────────────────────────────────────────────────

describe("listStudies — pagination", () => {
  it("returns the correct page shape when there are no studies", async () => {
    mockRepo.countStudies.mockResolvedValue(0);
    mockRepo.findStudies.mockResolvedValue([]);

    const result = await listStudies(1, 20, EMPTY_FILTERS, "medico");

    expect(result).toEqual({
      studies: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
  });

  it("computes totalPages correctly from total and limit", async () => {
    mockRepo.countStudies.mockResolvedValue(45);
    mockRepo.findStudies.mockResolvedValue([makeStudyRow()]);

    const result = await listStudies(1, 20, EMPTY_FILTERS, "medico");

    expect(result.total).toBe(45);
    expect(result.totalPages).toBe(3); // ceil(45/20)
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it("passes the correct offset for page 3 (limit 10 → offset 20)", async () => {
    mockRepo.countStudies.mockResolvedValue(50);
    mockRepo.findStudies.mockResolvedValue([]);

    await listStudies(3, 10, EMPTY_FILTERS, "medico");

    // findStudies receives (filters, limit, offset)
    expect(mockRepo.findStudies).toHaveBeenCalledWith(EMPTY_FILTERS, 10, 20);
  });

  it("echoes the requested page and limit in the result", async () => {
    mockRepo.countStudies.mockResolvedValue(5);
    mockRepo.findStudies.mockResolvedValue([makeStudyRow()]);

    const result = await listStudies(2, 5, EMPTY_FILTERS, "medico");

    expect(result.page).toBe(2);
    expect(result.limit).toBe(5);
  });
});

describe("listStudies — filtering", () => {
  it("forwards all filters to countStudies and findStudies", async () => {
    const filters: StudyFilters = {
      modality: "CT",
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
      search: "Doe",
      zenodoLinked: true,
      description: null,
      validationStatus: null,
    };
    mockRepo.countStudies.mockResolvedValue(1);
    mockRepo.findStudies.mockResolvedValue([makeStudyRow()]);

    await listStudies(1, 20, filters, "medico");

    expect(mockRepo.countStudies).toHaveBeenCalledWith(filters);
    expect(mockRepo.findStudies).toHaveBeenCalledWith(filters, 20, 0);
  });

  it("neutralizes the search filter for investigador to prevent PHI oracle", async () => {
    const filters: StudyFilters = { ...EMPTY_FILTERS, search: "Doe" };
    mockRepo.countStudies.mockResolvedValue(1);
    mockRepo.findStudies.mockResolvedValue([makeStudyRow()]);

    await listStudies(1, 20, filters, "investigador");

    // search must be nulled out before hitting the repo
    expect(mockRepo.countStudies).toHaveBeenCalledWith(
      expect.objectContaining({ search: null }),
    );
    expect(mockRepo.findStudies).toHaveBeenCalledWith(
      expect.objectContaining({ search: null }),
      20,
      0,
    );
  });

  it("passes the search filter through unchanged for medico", async () => {
    const filters: StudyFilters = { ...EMPTY_FILTERS, search: "Doe" };
    mockRepo.countStudies.mockResolvedValue(1);
    mockRepo.findStudies.mockResolvedValue([makeStudyRow()]);

    await listStudies(1, 20, filters, "medico");

    expect(mockRepo.countStudies).toHaveBeenCalledWith(
      expect.objectContaining({ search: "Doe" }),
    );
  });
});

describe("listStudies — PHI redaction", () => {
  it("leaves patient data untouched for medico", async () => {
    mockRepo.countStudies.mockResolvedValue(1);
    mockRepo.findStudies.mockResolvedValue([makeStudyRow()]);

    const { studies } = await listStudies(1, 20, EMPTY_FILTERS, "medico");

    expect(studies[0].patient_name).toBe("Doe^John");
    expect(studies[0].patient_id).toBe("PID-001");
  });

  it("redacts patient_name and pseudonymizes patient_id for investigador", async () => {
    mockRepo.countStudies.mockResolvedValue(1);
    mockRepo.findStudies.mockResolvedValue([makeStudyRow()]);

    const { studies } = await listStudies(1, 20, EMPTY_FILTERS, "investigador");

    expect(studies[0].patient_name).not.toBe("Doe^John");
    expect(studies[0].patient_id).not.toBe("PID-001");
    // pseudonymized id must look like ANON-{hex}
    expect(studies[0].patient_id).toMatch(/^ANON-[0-9a-f]{16}$/);
  });

  it("returns multiple studies all redacted for investigador", async () => {
    const rows = [
      makeStudyRow({
        orthanc_study_id: "s1",
        patient_name: "Alice^A",
        patient_id: "P1",
      }),
      makeStudyRow({
        orthanc_study_id: "s2",
        patient_name: "Bob^B",
        patient_id: "P2",
      }),
    ];
    mockRepo.countStudies.mockResolvedValue(2);
    mockRepo.findStudies.mockResolvedValue(rows);

    const { studies } = await listStudies(1, 20, EMPTY_FILTERS, "investigador");

    expect(studies).toHaveLength(2);
    for (const s of studies) {
      expect(s.patient_name).not.toMatch(/Alice|Bob/);
    }
  });
});

describe("listStudies — error handling", () => {
  it("wraps a repo error in an HttpError 500", async () => {
    mockRepo.countStudies.mockRejectedValue(new Error("DB error"));

    let caught: unknown;
    try {
      await listStudies(1, 20, EMPTY_FILTERS, "medico");
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(500);
  });
});

// ── getStudyDicomFile ─────────────────────────────────────────────────────────

describe("getStudyDicomFile", () => {
  it("returns a Buffer with the DICOM bytes for medico", async () => {
    const buf = await getStudyDicomFile("study-1", "medico");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(orthancClient.getInstanceFile).toHaveBeenCalledWith("inst-1");
    expect(orthancClient.anonymizeInstance).not.toHaveBeenCalled();
  });

  it("returns anonymized bytes for investigador", async () => {
    const buf = await getStudyDicomFile("study-1", "investigador");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(orthancClient.anonymizeInstance).toHaveBeenCalledWith("inst-1");
    expect(orthancClient.getInstanceFile).not.toHaveBeenCalled();
  });

  it("throws 404 when the study has no instances in the DB", async () => {
    mockRepo.findFirstInstanceId.mockResolvedValue(null);

    let caught: unknown;
    try {
      await getStudyDicomFile("missing-study", "medico");
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(404);
  });

  it("throws 503 when Orthanc is unavailable", async () => {
    orthancClient.getInstanceFile.mockRejectedValue(new Error("ECONNREFUSED"));

    let caught: unknown;
    try {
      await getStudyDicomFile("study-1", "medico");
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(503);
  });

  it("throws 404 when Orthanc returns 404 for the instance", async () => {
    const err: any = new Error("Not Found");
    err.response = { status: 404 };
    orthancClient.getInstanceFile.mockRejectedValue(err);

    let caught: unknown;
    try {
      await getStudyDicomFile("study-1", "medico");
    } catch (e) {
      caught = e;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(404);
  });
});

// ── getStudyInstances ─────────────────────────────────────────────────────────

describe("getStudyInstances", () => {
  it("returns an InstancesPayload with the studyId and instance list", async () => {
    const result = await getStudyInstances("study-1");
    expect(result).toHaveProperty("studyId", "study-1");
    expect(result).toHaveProperty("instances");
    expect(Array.isArray(result.instances)).toBe(true);
  });

  it("throws 404 when no instances are found", async () => {
    mockRepo.findInstances.mockResolvedValue([]);

    let caught: unknown;
    try {
      await getStudyInstances("empty-study");
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(404);
  });
});

// ── getInstanceDicomFile ──────────────────────────────────────────────────────

describe("getInstanceDicomFile", () => {
  it("returns DICOM bytes when the instance exists", async () => {
    mockRepo.instanceExists.mockResolvedValue(true);
    const buf = await getInstanceDicomFile("study-1", "inst-1", "medico");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(orthancClient.getInstanceFile).toHaveBeenCalledWith("inst-1");
  });

  it("returns anonymized bytes for investigador", async () => {
    mockRepo.instanceExists.mockResolvedValue(true);
    const buf = await getInstanceDicomFile("study-1", "inst-1", "investigador");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(orthancClient.anonymizeInstance).toHaveBeenCalledWith("inst-1");
  });

  it("throws 404 when the (study, instance) pair is not in the DB", async () => {
    mockRepo.instanceExists.mockResolvedValue(false);

    let caught: unknown;
    try {
      await getInstanceDicomFile("study-1", "inst-999", "medico");
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(404);
  });
});

// ── getStudyThumbnail ─────────────────────────────────────────────────────────

describe("getStudyThumbnail", () => {
  it("returns a buffer and content-type from Orthanc's preview endpoint", async () => {
    const result = await getStudyThumbnail("study-1");
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
    expect(orthancClient.getInstancePreview).toHaveBeenCalledWith("inst-1");
  });

  it("throws 404 when the study has no instances", async () => {
    mockRepo.findFirstInstanceId.mockResolvedValue(null);

    let caught: unknown;
    try {
      await getStudyThumbnail("missing-study");
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(404);
  });

  it("throws 422 when Orthanc cannot render the DICOM type (415)", async () => {
    const err: any = new Error("Unsupported Media Type");
    err.response = { status: 415 };
    orthancClient.getInstancePreview.mockRejectedValue(err);

    let caught: unknown;
    try {
      await getStudyThumbnail("study-1");
    } catch (e) {
      caught = e;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(422);
  });

  it("throws 503 when Orthanc is unreachable", async () => {
    orthancClient.getInstancePreview.mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    let caught: unknown;
    try {
      await getStudyThumbnail("study-1");
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(503);
  });

  it("defaults content-type to image/jpeg when Orthanc omits the header", async () => {
    orthancClient.getInstancePreview.mockResolvedValue({
      data: Buffer.from("jpeg"),
      headers: {},
    });
    const result = await getStudyThumbnail("study-1");
    expect(result.contentType).toBe("image/jpeg");
  });
});
