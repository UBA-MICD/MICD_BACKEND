/**
 * Unit tests for ml.service — business logic for ML prediction of studies.
 * The repository and orthancClient are mocked; no live DB or Orthanc required.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../../src/modules/studies/ml.repository");
jest.mock("../../../src/clients/orthanc.client", () => ({
  orthancClient: {
    getStudyInstances: jest.fn(),
  },
}));
jest.mock("../../../src/shared/audit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AUDIT_ACTIONS: (jest.requireActual("../../../src/shared/audit") as any)
    .AUDIT_ACTIONS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logAction: (jest.fn() as any).mockResolvedValue(null),
}));

import * as mlRepo from "../../../src/modules/studies/ml.repository";
import { orthancClient } from "../../../src/clients/orthanc.client";
import {
  analyzeStudy,
  getLatestPrediction,
} from "../../../src/modules/studies/ml.service";

const mockRepo = mlRepo as jest.Mocked<typeof mlRepo>;
const mockOrthanc = orthancClient as jest.Mocked<typeof orthancClient>;

const STUDY_ID = "1.2.3.4.5";
const USER_ID = 1;
const IP = "127.0.0.1";

const RECORD: mlRepo.MLPredictionRecord = {
  predictionId: 1,
  studyId: STUDY_ID,
  label: "normal",
  confidence: 0.87,
  analyzedBy: "admin@micd.local",
  analyzedAt: new Date("2026-09-06T10:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  // By default the study exists in Orthanc
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockOrthanc.getStudyInstances as jest.MockedFunction<any>).mockResolvedValue(
    {
      data: ["inst-001"],
      status: 200,
    },
  );
});

// ── analyzeStudy ──────────────────────────────────────────────────────────────

describe("analyzeStudy", () => {
  it("inserts a prediction and returns the response", async () => {
    mockRepo.insertPrediction.mockResolvedValue(RECORD);

    const result = await analyzeStudy(STUDY_ID, USER_ID, IP);

    expect(mockRepo.insertPrediction).toHaveBeenCalledWith({
      studyId: STUDY_ID,
      label: "normal",
      confidence: 0.87,
      userId: USER_ID,
    });
    expect(result).toEqual({
      predictionId: 1,
      studyId: STUDY_ID,
      label: "normal",
      confidence: 0.87,
      analyzedBy: "admin@micd.local",
      analyzedAt: "2026-09-06T10:00:00.000Z",
    });
  });

  it("throws 404 when Orthanc does not find the study", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (
      mockOrthanc.getStudyInstances as jest.MockedFunction<any>
    ).mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { status: 404 } }),
    );

    await expect(analyzeStudy(STUDY_ID, USER_ID, IP)).rejects.toMatchObject({
      status: 404,
    });
    expect(mockRepo.insertPrediction).not.toHaveBeenCalled();
  });
});

// ── getLatestPrediction ───────────────────────────────────────────────────────

describe("getLatestPrediction", () => {
  it("returns mapped response when prediction exists", async () => {
    mockRepo.findLatestPrediction.mockResolvedValue(RECORD);

    const result = await getLatestPrediction(STUDY_ID);

    expect(result).toEqual({
      predictionId: 1,
      studyId: STUDY_ID,
      label: "normal",
      confidence: 0.87,
      analyzedBy: "admin@micd.local",
      analyzedAt: "2026-09-06T10:00:00.000Z",
    });
  });

  it("returns null when no prediction exists", async () => {
    mockRepo.findLatestPrediction.mockResolvedValue(null);

    const result = await getLatestPrediction(STUDY_ID);

    expect(result).toBeNull();
  });
});
