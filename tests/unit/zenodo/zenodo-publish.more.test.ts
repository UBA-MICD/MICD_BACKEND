import axios from "axios";
import { pool } from "../../../src/db/pool";
import * as zenodoService from "../../../src/modules/zenodo/zenodo.service";
import {
  publishStudy,
  retryFailedFiles,
  getDeposition,
  getDepositionFiles,
} from "../../../src/modules/zenodo/zenodo-publish.service";

jest.mock("axios");
jest.mock("../../../src/db/pool", () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock("../../../src/modules/zenodo/zenodo.service", () => ({
  getStoredToken: jest.fn(),
  ZENODO_ENVIRONMENTS: ["sandbox", "production"],
}));
jest.mock("../../../src/shared/audit", () => ({
  AUDIT_ACTIONS: {
    ZENODO_STUDY_PUBLISHED: "ZENODO_STUDY_PUBLISHED",
    ZENODO_PUBLISH_FAILED: "ZENODO_PUBLISH_FAILED",
  },
  logAction: jest.fn().mockResolvedValue(undefined),
  logActionWithClient: jest.fn(),
}));
// FIFTY_GB shrunk to 1 MB so the size guard is reachable with small buffers
jest.mock("../../../src/modules/zenodo/zenodo-rate-limit.service", () => ({
  throttle: jest.fn().mockResolvedValue(undefined),
  THROTTLE_AT: 50,
  FIFTY_GB: 1024 * 1024,
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const poolQuery = pool.query as jest.Mock;
const poolConnect = pool.connect as jest.Mock;
const mockedGetStoredToken = zenodoService.getStoredToken as jest.Mock;

const SMALL = Buffer.from("small dicom");
const HUGE = Buffer.alloc(2 * 1024 * 1024); // 2 MB > mocked 1 MB limit

const OPTS = {
  orthancStudyId: "study-1",
  environment: "sandbox" as const,
  metadata: { title: "T", description: "D", authors: [{ name: "A" }] },
  userId: 1,
  ip: "127.0.0.1",
};

function makeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe("publishStudy — remaining branches", () => {
  it("throws orthanc_unavailable when a DICOM file cannot be fetched", async () => {
    mockedGetStoredToken.mockResolvedValue("tok");
    poolQuery.mockResolvedValueOnce({
      rows: [{ orthanc_instance_id: "inst-1", anonymized_at: new Date() }],
    });
    mockedAxios.get.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(publishStudy(OPTS)).rejects.toMatchObject({ code: "orthanc_unavailable" });
  });

  it("throws file_too_large when over the limit and force flag is off", async () => {
    mockedGetStoredToken.mockResolvedValue("tok");
    poolQuery.mockResolvedValueOnce({
      rows: [{ orthanc_instance_id: "inst-1", anonymized_at: new Date() }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: HUGE } as any);

    await expect(publishStudy(OPTS)).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("proceeds past the size guard when forceLargeUpload is true", async () => {
    mockedGetStoredToken.mockResolvedValue("tok");
    poolQuery
      .mockResolvedValueOnce({
        rows: [{ orthanc_instance_id: "inst-1", anonymized_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // INSERT deposition
      .mockResolvedValueOnce({ rows: [] }) // INSERT file row
      .mockResolvedValueOnce({
        rows: [{ id: 10, orthanc_instance_id: "inst-1", filename: "inst-1.dcm" }],
      }) // SELECT file rows
      .mockResolvedValue({ rows: [] }); // UPDATEs

    mockedAxios.get
      .mockResolvedValueOnce({ data: HUGE } as any) // size check
      .mockResolvedValueOnce({ data: HUGE } as any); // upload fetch
    mockedAxios.post
      .mockResolvedValueOnce({ data: { id: 99, links: { bucket: "https://b" } } } as any)
      .mockResolvedValueOnce({ data: { doi: "10.5281/zenodo.99" } } as any);
    mockedAxios.put.mockResolvedValue({ data: {} } as any);
    poolConnect.mockResolvedValue(makeClient() as any);

    const result = await publishStudy({ ...OPTS, forceLargeUpload: true });
    expect(result.doi).toBe("10.5281/zenodo.99");
  });

  it("throws publish_rejected and marks the deposition failed when Zenodo rejects publish", async () => {
    mockedGetStoredToken.mockResolvedValue("tok");
    poolQuery
      .mockResolvedValueOnce({
        rows: [{ orthanc_instance_id: "inst-1", anonymized_at: new Date() }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 10, orthanc_instance_id: "inst-1", filename: "inst-1.dcm" }],
      })
      .mockResolvedValue({ rows: [] });

    mockedAxios.get.mockResolvedValue({ data: SMALL } as any);
    mockedAxios.put.mockResolvedValue({ data: {} } as any);
    mockedAxios.post
      .mockResolvedValueOnce({ data: { id: 99, links: { bucket: "https://b" } } } as any)
      .mockRejectedValue({ message: "validation error" }); // publish fails all retries

    await expect(publishStudy(OPTS)).rejects.toMatchObject({ code: "publish_rejected" });

    const failedUpdate = poolQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("status='failed'"),
    );
    expect(failedUpdate).toBeDefined();
  }, 15000);
});

describe("deposition getters", () => {
  it("getDeposition returns the row or null", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: "draft" }] });
    await expect(getDeposition(1)).resolves.toMatchObject({ id: 1 });

    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getDeposition(2)).resolves.toBeNull();
  });

  it("getDepositionFiles returns the file rows", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 11 }] });
    await expect(getDepositionFiles(1)).resolves.toHaveLength(2);
  });
});

describe("retryFailedFiles — remaining branches", () => {
  it("throws no_credentials when the environment has no token", async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ id: 1, status: "failed", environment: "sandbox" }],
    });
    mockedGetStoredToken.mockResolvedValue(null);

    await expect(retryFailedFiles(1, 1, "")).rejects.toMatchObject({ code: "no_credentials" });
  });

  it("counts a file as failed again when its re-upload keeps failing", async () => {
    mockedGetStoredToken.mockResolvedValue("tok");
    poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            status: "failed",
            environment: "sandbox",
            zenodo_id: 99,
            bucket_url: "https://b",
            orthanc_study_id: "study-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 10, orthanc_instance_id: "inst-1", filename: "inst-1.dcm" }],
      })
      .mockResolvedValue({ rows: [] });

    mockedAxios.get.mockResolvedValue({ data: SMALL } as any);
    mockedAxios.put.mockRejectedValue(new Error("still broken"));

    const result = await retryFailedFiles(1, 1, "");
    expect(result).toEqual({ retried: 0, failed: 1 });
    expect(mockedAxios.post).not.toHaveBeenCalled(); // publish never attempted
  }, 15000);

  it("skips publishing when some files are still not completed", async () => {
    mockedGetStoredToken.mockResolvedValue("tok");
    poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            status: "failed",
            environment: "sandbox",
            zenodo_id: 99,
            bucket_url: "https://b",
            orthanc_study_id: "study-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // no failed files to retry
      .mockResolvedValueOnce({ rows: [{ count: "2" }] }); // 2 files still pending

    const result = await retryFailedFiles(1, 1, "");
    expect(result).toEqual({ retried: 0, failed: 0 });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("marks the deposition failed when the final publish attempt is rejected", async () => {
    mockedGetStoredToken.mockResolvedValue("tok");
    poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            status: "failed",
            environment: "sandbox",
            zenodo_id: 99,
            bucket_url: "https://b",
            orthanc_study_id: "study-1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // no failed files
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // everything completed
      .mockResolvedValue({ rows: [] });

    mockedAxios.post.mockRejectedValue({ message: "publish rejected" });

    const result = await retryFailedFiles(1, 1, "");
    expect(result).toEqual({ retried: 0, failed: 0 });

    const failedUpdate = poolQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("status='failed'"),
    );
    expect(failedUpdate).toBeDefined();
  }, 15000);
});
