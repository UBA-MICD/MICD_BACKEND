import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../../src/modules/zenodo/zenodo-search.service", () => ({
  getZenodoRecord: jest.fn(),
}));
jest.mock("../../../src/clients/zenodo.client", () => ({
  zenodoClient: {
    getRecord: jest.fn(),
    searchRecords: jest.fn(),
  },
}));
jest.mock("../../../src/modules/zenodo/zenodo.service", () => ({
  getStoredToken: jest.fn(),
  ZENODO_ENVIRONMENTS: ["sandbox", "production"],
}));
jest.mock("../../../src/modules/zenodo/zenodo-rate-limit.service", () => ({
  throttle: jest.fn(),
}));

import {
  parseZenodoInput,
  resolveZenodoRecord,
} from "../../../src/modules/zenodo/zenodo-resolve.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

const zenodoSearchMock = jest.requireMock(
  "../../../src/modules/zenodo/zenodo-search.service",
) as { getZenodoRecord: AnyMock };
const zenodoClientMock = (
  jest.requireMock("../../../src/clients/zenodo.client") as {
    zenodoClient: { getRecord: AnyMock; searchRecords: AnyMock };
  }
).zenodoClient;
const zenodoServiceMock = jest.requireMock("../../../src/modules/zenodo/zenodo.service") as {
  getStoredToken: AnyMock;
};
const rateLimitMock = jest.requireMock(
  "../../../src/modules/zenodo/zenodo-rate-limit.service",
) as { throttle: AnyMock };

beforeEach(() => {
  jest.clearAllMocks();
  zenodoServiceMock.getStoredToken.mockResolvedValue(null);
  rateLimitMock.throttle.mockResolvedValue(undefined);
});

describe("parseZenodoInput", () => {
  it.each([
    ["10.5281/zenodo.1234567", 1234567, "production"],
    ["10.5072/zenodo.7654321", 7654321, "sandbox"],
    ["https://doi.org/10.5281/zenodo.1234567", 1234567, "production"],
    ["http://dx.doi.org/10.5281/zenodo.1234567", 1234567, "production"],
    ["doi:10.5281/zenodo.1234567", 1234567, "production"],
    ["https://zenodo.org/records/1234567", 1234567, "production"],
    ["https://zenodo.org/record/1234567", 1234567, "production"],
    ["https://sandbox.zenodo.org/records/1234567", 1234567, "sandbox"],
    ["https://zenodo.org/records/1234567/", 1234567, "production"],
    ["https://zenodo.org/records/1234567?preview=1", 1234567, "production"],
    ["  10.5281/zenodo.1234567  ", 1234567, "production"],
    ["10.5281/ZENODO.1234567", 1234567, "production"],
  ])("resolves %s", (input, recordId, environment) => {
    expect(parseZenodoInput(input)).toEqual({ recordId, environment });
  });

  it.each([
    [""],
    ["   "],
    ["not a doi"],
    ["10.6084/m9.figshare.1234567"], // a real, non-Zenodo repository's DOI shape
    ["10.52/zenodo.123"], // prefix shorter than the required 4+ digits
    ["https://example.com/records/123"],
    ["https://zenodo.org/communities/foo"],
  ])("rejects %s", (input) => {
    expect(parseZenodoInput(input)).toBeNull();
  });
});

describe("resolveZenodoRecord", () => {
  const fakeRecord = {
    id: 1234567,
    doi: "10.5281/zenodo.1234567",
    title: "Test Study",
    authors: [{ name: "Author One" }],
    publicationDate: "2024-01-01",
    license: "cc-by",
    totalSize: 1000,
    numFiles: 1,
    importable: true,
    url: "https://zenodo.org/record/1234567",
    description: "A test study",
    keywords: ["DICOM"],
    files: [],
  };

  beforeEach(() => {
    zenodoSearchMock.getZenodoRecord.mockResolvedValue(fakeRecord);
    zenodoClientMock.getRecord.mockResolvedValue({ data: { conceptrecid: null } });
    zenodoClientMock.searchRecords.mockResolvedValue({ data: { hits: { hits: [] } } });
  });

  it("returns the record with no versions when the record has no conceptrecid", async () => {
    const result = await resolveZenodoRecord(1234567, "production");

    expect(result.record).toEqual(fakeRecord);
    expect(result.versions).toEqual([]);
    expect(result.environment).toBe("production");
    expect(zenodoClientMock.searchRecords).not.toHaveBeenCalled();
  });

  it("builds a version list marking the latest and the resolved (selected) version", async () => {
    zenodoClientMock.getRecord.mockResolvedValue({ data: { conceptrecid: "999" } });
    zenodoClientMock.searchRecords.mockResolvedValue({
      data: {
        hits: {
          hits: [
            { id: 1111111, doi: "10.5281/zenodo.1111111", metadata: { version: "1", publication_date: "2023-01-01" } },
            { id: 1234567, doi: "10.5281/zenodo.1234567", metadata: { version: "2", publication_date: "2024-01-01" } },
            { id: 2222222, doi: "10.5281/zenodo.2222222", metadata: { version: "3", publication_date: "2025-01-01" } },
          ],
        },
      },
    });

    const result = await resolveZenodoRecord(1234567, "production");

    expect(result.versions).toHaveLength(3);
    expect(result.versions.find((v) => v.recordId === 2222222)?.isLatest).toBe(true);
    expect(result.versions.find((v) => v.recordId === 1234567)?.isSelected).toBe(true);
    expect(result.versions.find((v) => v.recordId === 1234567)?.isLatest).toBe(false);
    expect(result.versions.filter((v) => v.isSelected)).toHaveLength(1);
  });

  it("propagates a 404 from getZenodoRecord untouched", async () => {
    const notFound = { response: { status: 404 } };
    zenodoSearchMock.getZenodoRecord.mockRejectedValue(notFound);

    await expect(resolveZenodoRecord(9999999, "production")).rejects.toBe(notFound);
    expect(zenodoClientMock.getRecord).not.toHaveBeenCalled();
  });
});
