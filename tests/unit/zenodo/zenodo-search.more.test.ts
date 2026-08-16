import axios from "axios";
import { searchZenodo, getZenodoRecord } from "../../../src/modules/zenodo/zenodo-search.service";

jest.mock("axios");
jest.mock("../../../src/modules/zenodo/zenodo.service", () => ({
  getStoredToken: jest.fn().mockResolvedValue(null),
  ZENODO_ENVIRONMENTS: ["sandbox", "production"],
}));
jest.mock("../../../src/modules/zenodo/zenodo-rate-limit.service", () => ({
  throttle: jest.fn().mockResolvedValue(undefined),
  THROTTLE_AT: 50,
  FIFTY_GB: 50 * 1024 * 1024 * 1024,
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const EMPTY = { data: { hits: { hits: [], total: 0 } } } as any;

beforeEach(() => jest.clearAllMocks());

describe("searchZenodo — query construction", () => {
  it("strips a leading dot from fileType", async () => {
    mockedAxios.get.mockResolvedValueOnce(EMPTY);
    await searchZenodo({ q: "DICOM", fileType: ".dcm" });
    expect(mockedAxios.get.mock.calls[0][1]?.params?.q).toContain("file_type:dcm");
  });

  it("appends keywords to the query", async () => {
    mockedAxios.get.mockResolvedValueOnce(EMPTY);
    await searchZenodo({ q: "DICOM", keywords: "lung CT" });
    expect(mockedAxios.get.mock.calls[0][1]?.params?.q).toBe("DICOM lung CT");
  });

  it("builds a bounded publication_date range from dateFrom + dateTo", async () => {
    mockedAxios.get.mockResolvedValueOnce(EMPTY);
    await searchZenodo({ q: "x", dateFrom: "2024-01-01", dateTo: "2024-12-31" });
    expect(mockedAxios.get.mock.calls[0][1]?.params?.q).toContain(
      "publication_date:[2024-01-01 TO 2024-12-31]",
    );
  });

  it("uses an open-ended range when only dateFrom is given", async () => {
    mockedAxios.get.mockResolvedValueOnce(EMPTY);
    await searchZenodo({ q: "x", dateFrom: "2024-01-01" });
    expect(mockedAxios.get.mock.calls[0][1]?.params?.q).toContain(
      "publication_date:[2024-01-01 TO *]",
    );
  });

  it("passes license as a separate query param", async () => {
    mockedAxios.get.mockResolvedValueOnce(EMPTY);
    await searchZenodo({ q: "x", license: "cc-by-4.0" });
    expect(mockedAxios.get.mock.calls[0][1]?.params?.license).toBe("cc-by-4.0");
  });

  it("defaults page to 1 and size to 20", async () => {
    mockedAxios.get.mockResolvedValueOnce(EMPTY);
    const result = await searchZenodo({ q: "x" });
    expect(result.page).toBe(1);
    expect(result.size).toBe(20);
    expect(mockedAxios.get.mock.calls[0][1]?.params).toMatchObject({ page: 1, size: 20 });
  });
});

describe("searchZenodo — record parsing fallbacks", () => {
  it("fills defaults for a bare record with no metadata/files/links", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [{ id: 42 }], total: 1 } },
    } as any);

    const result = await searchZenodo({ q: "x" });
    const rec = result.records[0];

    expect(rec.title).toBe("(sin título)");
    expect(rec.doi).toBeNull();
    expect(rec.authors).toEqual([]);
    expect(rec.license).toBeNull();
    expect(rec.numFiles).toBe(0);
    expect(rec.totalSize).toBe(0);
    expect(rec.importable).toBe(false);
    expect(rec.url).toBe("https://zenodo.org/record/42");
  });

  it("falls back to filename and size 0 for legacy file entries, license as plain string", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        hits: {
          hits: [
            {
              id: 7,
              metadata: { title: "T", license: "mit" },
              files: [{ filename: "legacy.dcm" }],
            },
          ],
          total: 1,
        },
      },
    } as any);

    const result = await searchZenodo({ q: "x" });
    expect(result.records[0].license).toBe("mit");
    expect(result.records[0].importable).toBe(true);
    expect(result.records[0].totalSize).toBe(0);
  });
});

describe("getZenodoRecord — environment default", () => {
  it("hits the production API when no environment is given", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { id: 5, files: [] } } as any);
    await getZenodoRecord(5);
    expect(String(mockedAxios.get.mock.calls[0][0])).toContain("https://zenodo.org/api/records/5");
  });
});
