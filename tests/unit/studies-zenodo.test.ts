/**
 * Unit tests for the Zenodo detail endpoint logic in studies.service.ts.
 * All I/O is mocked — no DB or network.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// ── Mock dependencies before importing the module under test ─────────────────

jest.mock("../../src/modules/studies/studies.repository", () => ({
  findStudyZenodoMeta: jest.fn(),
}));
jest.mock("../../src/modules/zenodo/zenodo-search.service", () => ({
  getZenodoRecord: jest.fn(),
}));
jest.mock("../../src/modules/zenodo/zenodo.service", () => ({
  getStoredToken: jest.fn(),
}));
jest.mock("../../src/clients/zenodo.client", () => ({
  zenodoClient: {
    getRecord: jest.fn(),
    searchRecords: jest.fn(),
  },
}));

import { getStudyZenodoDetail } from "../../src/modules/studies/studies.service";

// Access mocks via requireMock — avoids import binding issues with ts-jest
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

const repoMock = jest.requireMock("../../src/modules/studies/studies.repository") as {
  findStudyZenodoMeta: AnyMock;
};
const zenodoSearchMock = jest.requireMock("../../src/modules/zenodo/zenodo-search.service") as {
  getZenodoRecord: AnyMock;
};
const zenodoServiceMock = jest.requireMock("../../src/modules/zenodo/zenodo.service") as {
  getStoredToken: AnyMock;
};
const zenodoClientMock = (jest.requireMock("../../src/clients/zenodo.client") as {
  zenodoClient: { getRecord: AnyMock; searchRecords: AnyMock };
}).zenodoClient;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseMeta = {
  zenodo_doi: null,
  zenodo_published_at: null,
  zenodo_source_doi: null,
  zenodo_source_record_id: null,
  zenodo_imported_at: null,
  zenodo_version: null,
  zenodo_concept_record_id: null,
  zenodo_new_version_available: null,
  patient_name: "Test Patient",
  study_date: "20240101",
  modality: "CT",
};

const fakeRecord = {
  id: 12345,
  doi: "10.5281/zenodo.12345",
  title: "Test Study",
  authors: [{ name: "Author One" }],
  publicationDate: "2024-01-01",
  license: "cc-by",
  totalSize: 1000,
  numFiles: 1,
  importable: true,
  url: "https://zenodo.org/record/12345",
  description: "A test study",
  keywords: ["DICOM"],
  files: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  zenodoSearchMock.getZenodoRecord.mockResolvedValue(fakeRecord);
  zenodoServiceMock.getStoredToken.mockResolvedValue(null);
  zenodoClientMock.getRecord.mockResolvedValue({ data: { stats: { downloads: 42 } } });
  zenodoClientMock.searchRecords.mockResolvedValue({ data: { hits: { hits: [] } } });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("getStudyZenodoDetail", () => {
  it("throws 404 when study is not found in DB", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue(null);
    await expect(getStudyZenodoDetail("nonexistent")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws 404 when study exists but has no Zenodo association", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({ ...baseMeta });
    await expect(getStudyZenodoDetail("study-1")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("returns status 'published' for a study with only zenodo_doi", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_doi: "10.5281/zenodo.12345",
      zenodo_published_at: new Date("2024-01-01"),
    });

    const result = await getStudyZenodoDetail("study-pub");

    expect(result.status).toBe("published");
    expect(result.doi).toBe("10.5281/zenodo.12345");
    expect(result.stale).toBe(false);
    expect(result.record).not.toBeNull();
    expect(result.record?.title).toBe("Test Study");
  });

  it("returns downloads from Zenodo stats when available", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_doi: "10.5281/zenodo.12345",
      zenodo_published_at: new Date("2024-01-01"),
    });
    zenodoClientMock.getRecord.mockResolvedValue({ data: { stats: { downloads: 42 } } });

    const result = await getStudyZenodoDetail("study-pub");

    expect(result.downloads).toBe(42);
  });

  it("returns downloads: null when Zenodo stats.downloads is absent", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_doi: "10.5281/zenodo.12345",
      zenodo_published_at: new Date("2024-01-01"),
    });
    zenodoClientMock.getRecord.mockResolvedValue({ data: {} }); // no stats field

    const result = await getStudyZenodoDetail("study-nostats");

    expect(result.downloads).toBeNull();
  });

  it("returns status 'imported' for a study with only zenodo_source_doi", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_source_doi: "10.5281/zenodo.99999",
      zenodo_source_record_id: 99999,
      zenodo_imported_at: new Date("2024-03-01"),
    });

    const result = await getStudyZenodoDetail("study-imp");

    expect(result.status).toBe("imported");
    expect(result.doi).toBe("10.5281/zenodo.99999");
    expect(result.stale).toBe(false);
  });

  it("returns status 'both' when study has both DOIs (published and imported)", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_doi: "10.5281/zenodo.12345",
      zenodo_published_at: new Date("2024-01-01"),
      zenodo_source_doi: "10.5281/zenodo.99999",
      zenodo_source_record_id: 99999,
      zenodo_imported_at: new Date("2024-03-01"),
    });

    const result = await getStudyZenodoDetail("study-both");

    expect(result.status).toBe("both");
    expect(result.stale).toBe(false);
  });

  it("returns stale: true and local data when Zenodo (getZenodoRecord) is unreachable", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_doi: "10.5281/zenodo.12345",
      zenodo_published_at: new Date("2024-01-01"),
    });
    zenodoSearchMock.getZenodoRecord.mockRejectedValue(new Error("Network error"));

    const result = await getStudyZenodoDetail("study-down");

    expect(result.stale).toBe(true);
    expect(result.record).toBeNull();
    expect(result.doi).toBe("10.5281/zenodo.12345");
    expect(result.lastSyncedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("includes version history when concept_record_id is present", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_doi: "10.5281/zenodo.12345",
      zenodo_published_at: new Date("2024-01-01"),
      zenodo_concept_record_id: 11111,
    });
    zenodoClientMock.searchRecords.mockResolvedValue({
      data: {
        hits: {
          hits: [
            {
              id: 12344,
              doi: "10.5281/zenodo.12344",
              metadata: { title: "v1", creators: [], publication_date: "2023-06-01", license: { id: "cc-by" } },
              files: [],
              links: { html: "https://zenodo.org/record/12344" },
            },
            {
              id: 12345,
              doi: "10.5281/zenodo.12345",
              metadata: { title: "v2", creators: [], publication_date: "2024-01-01", license: { id: "cc-by" } },
              files: [],
              links: { html: "https://zenodo.org/record/12345" },
            },
          ],
        },
      },
    });

    const result = await getStudyZenodoDetail("study-versions");

    expect(result.versions).toHaveLength(2);
    expect(result.latestVersion).toBe("2024-01-01");
  });

  it("surfaces newVersionAvailable from local DB flag", async () => {
    repoMock.findStudyZenodoMeta.mockResolvedValue({
      ...baseMeta,
      zenodo_source_doi: "10.5281/zenodo.99999",
      zenodo_source_record_id: 99999,
      zenodo_new_version_available: true,
    });

    const result = await getStudyZenodoDetail("study-newver");

    expect(result.newVersionAvailable).toBe(true);
  });
});
