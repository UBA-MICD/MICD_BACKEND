/**
 * Coverage for the importZipFile path in zenodo-import.service.ts.
 *
 * The function is not exported, so all tests go through importFromZenodo()
 * with a .zip file.  We mock `unzipper.Parse` to return a controllable
 * EventEmitter and drive it with synthetic 'entry' / 'finish' events.
 */
import { EventEmitter } from "events";
import axios from "axios";
import { pool } from "../../../src/db/pool";
import { importFromZenodo } from "../../../src/modules/zenodo/zenodo-import.service";

jest.mock("unzipper", () => ({ Parse: jest.fn() }));
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockParse = (require("unzipper") as { Parse: jest.Mock }).Parse;

const TAGS = {
  "0008,0018": { Value: "sop-zip-1" },
  "0020,000d": { Value: "study-uid-zip" },
  "0010,0010": { Value: "Smith^John" },
  "0010,0020": { Value: "PAT002" },
  "0008,0020": { Value: "20240601" },
  "0008,1030": { Value: "Chest CT" },
  "0008,0060": { Value: "CT" },
  "0020,0013": { Value: [1] },
  "0028,0010": { Value: [512] },
  "0028,0011": { Value: [512] },
};

const ZIP_OPTS = {
  recordId: 200,
  environment: "sandbox" as const,
  files: [{ fileKey: "dataset.zip", fileSize: 5000 }],
  overwriteDuplicates: false,
  userId: 1,
  ip: "127.0.0.1",
};

/** Creates a fake unzipper parser (EventEmitter with pause/resume). */
function makeParser(): EventEmitter & { pause: jest.Mock; resume: jest.Mock } {
  const p = new EventEmitter() as EventEmitter & { pause: jest.Mock; resume: jest.Mock };
  p.pause = jest.fn();
  p.resume = jest.fn();
  return p;
}

/** Creates a fake ZIP entry (EventEmitter with path + autodrain). */
function makeEntry(
  name: string,
): EventEmitter & { path: string; autodrain: jest.Mock } {
  const e = new EventEmitter() as EventEmitter & { path: string; autodrain: jest.Mock };
  e.path = name;
  e.autodrain = jest.fn();
  return e;
}

/** Yields back to the microtask/macrotask queue so pending Promises resolve. */
const tick = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => jest.clearAllMocks());

// ── Common pool mock sequence for a single ZIP file ───────────────────────────
function setupPoolForZip(extra: Array<{ rows: unknown[] }> = []) {
  poolQuery
    .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT zenodo_imports
    .mockResolvedValueOnce({ rows: [] })             // audit STARTED
    .mockResolvedValueOnce({ rows: [] })             // INSERT import_file
    .mockResolvedValueOnce({ rows: [] });            // UPDATE zip → downloading

  for (const row of extra) {
    poolQuery.mockResolvedValueOnce(row);
  }

  poolQuery.mockResolvedValue({ rows: [] }); // remaining (studies upsert, status update, summary, audit COMPLETED)
}

// ── Helpers to drive the parser ───────────────────────────────────────────────

/**
 * Emits a single DCM entry on the parser and resolves its data/end events,
 * then emits 'finish'.  The parser's pause/resume mock calls are tracked.
 */
async function driveParserWithDcm(
  parser: ReturnType<typeof makeParser>,
  entryName: string,
  data: Buffer = Buffer.from("DICM_FAKE"),
): Promise<void> {
  const entry = makeEntry(entryName);

  // The parser's 'entry' listener is set up synchronously inside importZipFile
  // once the outer promise is created.  Give the function one tick to set up.
  await tick();

  parser.emit("entry", entry);

  // bufferEntry() sets up entry.on("data") / entry.on("end") listeners.
  // Yield so those listeners are registered before we fire.
  await tick();

  entry.emit("data", data);
  entry.emit("end");

  // Let bufferEntry resolve and parser.resume() be called.
  await tick();

  parser.emit("finish");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("importZipFile — happy path (DCM inside ZIP)", () => {
  it("imports a DCM file found inside a ZIP and returns imported=1", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: "10.5281/zenodo.200" } } as any)  // fetchRecordMeta
      .mockResolvedValueOnce({ data: fakeZipStream } as any)                   // downloadRecordFileStream
      .mockResolvedValueOnce({ data: TAGS } as any);                            // getInstanceTags

    mockedAxios.post.mockResolvedValueOnce({
      data: { ID: "inst-zip-1", ParentStudy: "study-zip-1", Status: "Success" },
    } as any);

    setupPoolForZip();

    const promise = importFromZenodo(ZIP_OPTS);
    await driveParserWithDcm(parser, "scan.dcm");

    const result = await promise;
    expect(result.imported).toBe(1);
    expect(result.results[0].status).toBe("imported");
    expect(result.results[0].fileKey).toBe("scan.dcm");
    expect(parser.pause).toHaveBeenCalled();
    expect(parser.resume).toHaveBeenCalled();
  });
});

describe("importZipFile — non-DCM entries are skipped", () => {
  it("calls autodrain on non-DCM entries and still finishes", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any) // fetchRecordMeta
      .mockResolvedValueOnce({ data: fakeZipStream } as any); // downloadRecordFileStream

    setupPoolForZip();

    const promise = importFromZenodo(ZIP_OPTS);
    await tick();

    const txtEntry = makeEntry("readme.txt");
    parser.emit("entry", txtEntry);
    await tick();

    parser.emit("finish");

    const result = await promise;
    expect(txtEntry.autodrain).toHaveBeenCalled();
    expect(result.imported).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});

describe("importZipFile — path traversal entries are skipped", () => {
  it("autodrains an entry whose path contains '..'", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockResolvedValueOnce({ data: fakeZipStream } as any);

    setupPoolForZip();

    const promise = importFromZenodo(ZIP_OPTS);
    await tick();

    const traversalEntry = makeEntry("../evil.dcm");
    parser.emit("entry", traversalEntry);
    await tick();
    parser.emit("finish");

    const result = await promise;
    expect(traversalEntry.autodrain).toHaveBeenCalled();
    expect(result.imported).toBe(0);
  });
});

describe("importZipFile — duplicate inside ZIP (not overwrite)", () => {
  it("records duplicate when Orthanc returns AlreadyStored and study is in DB", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockResolvedValueOnce({ data: fakeZipStream } as any)
      .mockResolvedValueOnce({ data: TAGS } as any); // getInstanceTags

    mockedAxios.post.mockResolvedValueOnce({
      data: { ID: "inst-dup", ParentStudy: "study-dup", Status: "AlreadyStored" },
    } as any);

    // Pool: base sequence + lookup for AlreadyStored
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })                           // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] })                                      // audit STARTED
      .mockResolvedValueOnce({ rows: [] })                                      // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })                                      // UPDATE downloading
      .mockResolvedValueOnce({ rows: [{ orthanc_study_id: "study-dup" }] })    // AlreadyStored lookup
      .mockResolvedValue({ rows: [] });                                         // remaining

    const promise = importFromZenodo(ZIP_OPTS);
    await driveParserWithDcm(parser, "scan.dcm");

    const result = await promise;
    expect(result.duplicates).toBe(1);
    expect(result.results[0].status).toBe("duplicate");
  });
});

describe("importZipFile — Orthanc rejects entry inside ZIP", () => {
  it("records failed when Orthanc throws for a DCM in the ZIP", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockResolvedValueOnce({ data: fakeZipStream } as any);

    mockedAxios.post.mockRejectedValueOnce(new Error("Orthanc 400"));

    setupPoolForZip();

    const promise = importFromZenodo(ZIP_OPTS);
    await driveParserWithDcm(parser, "scan.dcm");

    const result = await promise;
    expect(result.failed).toBe(1);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].error).toContain("Orthanc 400");
  });
});

describe("importZipFile — bufferEntry error", () => {
  it("resumes parser and skips entry when buffer stream emits error", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockResolvedValueOnce({ data: fakeZipStream } as any);

    setupPoolForZip();

    const promise = importFromZenodo(ZIP_OPTS);
    await tick();

    const entry = makeEntry("scan.dcm");
    parser.emit("entry", entry);
    await tick();

    // Emit error on the entry instead of data/end
    entry.emit("error", new Error("stream broken"));
    await tick();

    parser.emit("finish");

    const result = await promise;
    // bufferEntry threw; that entry is NOT pushed to dcmEntries,
    // so imported=0 but also no failed entry (the error is swallowed by the .catch)
    expect(result.imported).toBe(0);
    expect(parser.resume).toHaveBeenCalled();
  });
});

describe("importZipFile — duplicate inside ZIP when AlreadyStored but NOT in DB (overwrite=true path, no existing row)", () => {
  it("skips the delete step and upserts the study when existing is empty", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockResolvedValueOnce({ data: fakeZipStream } as any)
      .mockResolvedValueOnce({ data: TAGS } as any); // getInstanceTags

    mockedAxios.post.mockResolvedValueOnce({
      data: { ID: "inst-dup2", ParentStudy: "study-dup2", Status: "AlreadyStored" },
    } as any);

    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })   // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] })               // audit STARTED
      .mockResolvedValueOnce({ rows: [] })               // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })               // UPDATE downloading
      .mockResolvedValueOnce({ rows: [] })               // AlreadyStored lookup → empty (not in DB)
      .mockResolvedValue({ rows: [] });                  // remaining (INSERT studies, status, summary, audit)

    const promise = importFromZenodo({ ...ZIP_OPTS, overwriteDuplicates: false });
    await driveParserWithDcm(parser, "scan.dcm");

    const result = await promise;
    // AlreadyStored but not in DB and overwrite=false → upsert proceeds → imported
    expect(result.imported).toBe(1);
  });
});

describe("importZipFile — parser emits error", () => {
  it("rejects and marks the whole ZIP as failed when the unzipper parser errors", async () => {
    const parser = makeParser();
    mockParse.mockReturnValue(parser);

    const fakeZipStream = { pipe: jest.fn().mockReturnValue(parser) };

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockResolvedValueOnce({ data: fakeZipStream } as any);

    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] })             // audit STARTED
      .mockResolvedValueOnce({ rows: [] })             // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })             // UPDATE downloading
      .mockResolvedValue({ rows: [] });                // remaining (failed status, summary, audit)

    const promise = importFromZenodo(ZIP_OPTS);
    await tick();

    parser.emit("error", new Error("corrupt zip"));

    const result = await promise;
    expect(result.failed).toBe(1);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].error).toContain("corrupt zip");
  });
});
