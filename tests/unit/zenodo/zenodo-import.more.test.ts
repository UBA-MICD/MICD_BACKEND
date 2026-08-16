import axios from "axios";
import { pool } from "../../../src/db/pool";
import {
  importFromZenodo,
  fetchRecordMeta,
  getImport,
  getImportFiles,
} from "../../../src/modules/zenodo/zenodo-import.service";

jest.mock("axios");
jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock("../../../src/modules/zenodo/zenodo.service", () => ({
  getStoredToken: jest.fn().mockResolvedValue(null),
  ZENODO_ENVIRONMENTS: ["sandbox", "production"],
}));
jest.mock("../../../src/shared/audit", () => ({
  AUDIT_ACTIONS: {
    ZENODO_IMPORT_STARTED: "ZENODO_IMPORT_STARTED",
    ZENODO_IMPORT_COMPLETED: "ZENODO_IMPORT_COMPLETED",
  },
}));
jest.mock("../../../src/modules/zenodo/zenodo-rate-limit.service", () => ({
  throttle: jest.fn().mockResolvedValue(undefined),
  THROTTLE_AT: 50,
  FIFTY_GB: 50 * 1024 * 1024 * 1024,
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const poolQuery = pool.query as jest.Mock;

const FAKE_STREAM = { pipe: jest.fn() };
const ORTHANC_OK = { ID: "inst-new", ParentStudy: "study-new", Status: "Success" };
const ORTHANC_ALREADY = { ID: "inst-dup", ParentStudy: "study-dup", Status: "AlreadyStored" };
const TAGS = {
  "0008,0018": { Value: "sop-1" },
  "0020,000d": { Value: "study-uid" },
  "0008,0060": { Value: "CT" },
};

const OPTS = {
  recordId: 100,
  environment: "sandbox" as const,
  files: [{ fileKey: "a.dcm", fileSize: 10 }],
  userId: 1,
  ip: "127.0.0.1",
};

beforeEach(() => jest.clearAllMocks());

describe("fetchRecordMeta", () => {
  it("parses doi, version and concept record id", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { doi: "10.5281/z.100", metadata: { version: "2.1" }, conceptrecid: "99" },
    } as any);

    await expect(fetchRecordMeta(100, "production", "tok")).resolves.toEqual({
      doi: "10.5281/z.100",
      version: "2.1",
      conceptRecordId: 99,
    });
  });

  it("returns nulls when the record fetch fails", async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error("timeout"));
    await expect(fetchRecordMeta(100, "production", null)).resolves.toEqual({
      doi: null,
      version: null,
      conceptRecordId: null,
    });
  });
});

describe("importFromZenodo — overwrite path", () => {
  it("deletes the existing instance and re-imports when overwrite=true", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] }) // audit STARTED
      .mockResolvedValueOnce({ rows: [] }) // INSERT import_file
      .mockResolvedValueOnce({ rows: [] }) // UPDATE downloading
      .mockResolvedValueOnce({ rows: [{ orthanc_study_id: "study-old" }] }) // existing lookup
      .mockResolvedValueOnce({ rows: [] }) // DELETE studies row
      .mockResolvedValueOnce({ rows: [] }) // INSERT studies (re-import)
      .mockResolvedValue({ rows: [] }); // remaining updates + audit

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any) // fetchRecordMeta
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any) // stream download
      .mockResolvedValueOnce({ data: TAGS } as any) // fetchTags
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any); // re-upload stream
    mockedAxios.post
      .mockResolvedValueOnce({ data: ORTHANC_ALREADY } as any) // first upload → duplicate
      .mockResolvedValueOnce({ data: ORTHANC_OK } as any); // re-upload
    mockedAxios.delete.mockResolvedValueOnce({ data: {} } as any);

    const result = await importFromZenodo({ ...OPTS, overwriteDuplicates: true });

    expect(mockedAxios.delete).toHaveBeenCalledWith(
      expect.stringContaining("/instances/inst-dup"),
      expect.anything(),
    );
    expect(result.imported).toBe(1);
    expect(result.results[0].orthancStudyId).toBe("study-new");
  });
});

describe("importFromZenodo — DB persistence failure", () => {
  it("marks the file failed when the studies upsert throws", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] }) // audit STARTED
      .mockResolvedValueOnce({ rows: [] }) // INSERT import_file
      .mockResolvedValueOnce({ rows: [] }) // UPDATE downloading
      .mockRejectedValueOnce(new Error("unique violation")) // INSERT studies
      .mockResolvedValue({ rows: [] }); // remaining updates + audit

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)
      .mockResolvedValueOnce({ data: TAGS } as any);
    mockedAxios.post.mockResolvedValueOnce({ data: ORTHANC_OK } as any);

    const result = await importFromZenodo(OPTS);

    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain("Error al guardar en BD");
  });
});

describe("importFromZenodo — overwrite re-upload failure", () => {
  it("returns failed when re-upload after delete throws", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })                        // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] })                                   // audit STARTED
      .mockResolvedValueOnce({ rows: [] })                                   // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })                                   // UPDATE downloading
      .mockResolvedValueOnce({ rows: [{ orthanc_study_id: "study-old" }] }) // existing lookup
      .mockResolvedValueOnce({ rows: [] })                                   // DELETE studies row
      .mockResolvedValue({ rows: [] });                                      // remaining

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)   // fetchRecordMeta
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)     // first download (streamFileToOrthanc)
      .mockResolvedValueOnce({ data: TAGS } as any);           // fetchTags
    mockedAxios.post.mockResolvedValueOnce({ data: ORTHANC_ALREADY } as any); // AlreadyStored
    mockedAxios.delete.mockResolvedValueOnce({ data: {} } as any);            // delete instance
    // re-upload download throws
    mockedAxios.get.mockRejectedValueOnce(new Error("re-upload network error"));

    const result = await importFromZenodo({ ...OPTS, overwriteDuplicates: true });

    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain("Fallo al re-importar");
  });
});

describe("importFromZenodo — AlreadyStored but not in DB (overwrite=false)", () => {
  it("registers the study when it is in Orthanc but missing from DB", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] })             // audit STARTED
      .mockResolvedValueOnce({ rows: [] })             // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })             // UPDATE downloading
      .mockResolvedValueOnce({ rows: [] })             // existing lookup → empty (not in DB)
      .mockResolvedValue({ rows: [] });                // delete (throws non-fatal), re-upload, studies, etc.

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)   // fetchRecordMeta
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)     // first upload stream
      .mockResolvedValueOnce({ data: TAGS } as any)            // fetchTags
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any);    // re-upload stream
    mockedAxios.post
      .mockResolvedValueOnce({ data: ORTHANC_ALREADY } as any) // AlreadyStored
      .mockResolvedValueOnce({ data: ORTHANC_OK } as any);     // re-upload succeeds
    mockedAxios.delete.mockResolvedValueOnce({ data: {} } as any);

    // overwriteDuplicates: false but not in DB → should fall through to re-register
    const result = await importFromZenodo({ ...OPTS, overwriteDuplicates: false });

    expect(result.imported).toBe(1);
  });
});

describe("importFromZenodo — fetchTags returns empty on Orthanc error", () => {
  it("still imports successfully even if getInstanceTags throws (tags become empty strings)", async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] })             // audit STARTED
      .mockResolvedValueOnce({ rows: [] })             // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })             // UPDATE downloading
      .mockResolvedValue({ rows: [] });                // remaining

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)  // fetchRecordMeta
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)    // streamFileToOrthanc download
      .mockRejectedValueOnce(new Error("Orthanc tags unreachable")); // getInstanceTags throws
    mockedAxios.post.mockResolvedValueOnce({ data: ORTHANC_OK } as any);

    const result = await importFromZenodo(OPTS);

    // fetchTags swallows the error and returns {}; empty tags lead to empty strings
    expect(result.imported).toBe(1);
  });
});

describe("import getters", () => {
  it("getImport returns the row or null", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: "completed" }] });
    await expect(getImport(42)).resolves.toMatchObject({ id: 42 });

    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getImport(43)).resolves.toBeNull();
  });

  it("getImportFiles returns the file rows", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    await expect(getImportFiles(42)).resolves.toHaveLength(2);
  });
});
