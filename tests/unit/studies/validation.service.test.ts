/**
 * Unit tests for validation.service — business logic for registering and
 * correcting study validations. The repository and studies.repository are
 * mocked; no live DB required.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../../src/modules/studies/validation.repository");
jest.mock("../../../src/modules/studies/studies.repository");
jest.mock("../../../src/shared/audit", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AUDIT_ACTIONS: (jest.requireActual("../../../src/shared/audit") as any)
    .AUDIT_ACTIONS,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logAction: (jest.fn() as any).mockResolvedValue(null),
}));

import * as validationRepo from "../../../src/modules/studies/validation.repository";
import * as studiesRepo from "../../../src/modules/studies/studies.repository";
import {
  validateStudy,
  correctStudyValidation,
} from "../../../src/modules/studies/validation.service";

const mockValidationRepo = validationRepo as jest.Mocked<typeof validationRepo>;
const mockStudiesRepo = studiesRepo as jest.Mocked<typeof studiesRepo>;

const STUDY_ID = "1.2.3.4.5";
const USER_ID = 7;
const IP = "127.0.0.1";

const RECORD = {
  validationId: 1,
  studyId: STUDY_ID,
  action: "approved" as const,
  comment: null,
  userId: USER_ID,
  validatedBy: "dr@micd.local",
  validatedAt: new Date("2026-09-04T10:00:00Z"),
  correctsId: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  // By default the study exists
  mockStudiesRepo.findFirstInstanceId.mockResolvedValue("inst-001");
});

// ── validateStudy ─────────────────────────────────────────────────────────────

describe("validateStudy", () => {
  it("returns a ValidationResponse on success", async () => {
    mockValidationRepo.insertValidation.mockResolvedValue(RECORD);

    const result = await validateStudy(
      STUDY_ID,
      "approved",
      undefined,
      USER_ID,
      IP,
    );

    expect(result).toEqual({
      validationId: 1,
      status: "approved",
      validatedBy: "dr@micd.local",
      validatedAt: "2026-09-04T10:00:00.000Z",
    });
  });

  it("passes comment to the repository", async () => {
    const recordWithComment = {
      ...RECORD,
      action: "rejected" as const,
      comment: "Calidad insuficiente",
    };
    mockValidationRepo.insertValidation.mockResolvedValue(recordWithComment);

    await validateStudy(
      STUDY_ID,
      "rejected",
      "Calidad insuficiente",
      USER_ID,
      IP,
    );

    expect(mockValidationRepo.insertValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rejected",
        comment: "Calidad insuficiente",
      }),
    );
  });

  it("throws 400 when action is rejected and comment is missing", async () => {
    await expect(
      validateStudy(STUDY_ID, "rejected", undefined, USER_ID, IP),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when action is rejected and comment is blank", async () => {
    await expect(
      validateStudy(STUDY_ID, "rejected", "   ", USER_ID, IP),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does NOT require a comment for approved action", async () => {
    mockValidationRepo.insertValidation.mockResolvedValue(RECORD);
    await expect(
      validateStudy(STUDY_ID, "approved", undefined, USER_ID, IP),
    ).resolves.toBeDefined();
  });

  it("does NOT require a comment for review action", async () => {
    mockValidationRepo.insertValidation.mockResolvedValue({
      ...RECORD,
      action: "review" as const,
    });
    await expect(
      validateStudy(STUDY_ID, "review", undefined, USER_ID, IP),
    ).resolves.toBeDefined();
  });

  it("throws 404 when study is not found", async () => {
    mockStudiesRepo.findFirstInstanceId.mockResolvedValue(null);

    await expect(
      validateStudy("nonexistent", "approved", undefined, USER_ID, IP),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("wraps unexpected DB errors as 500", async () => {
    mockValidationRepo.insertValidation.mockRejectedValue(new Error("DB down"));

    await expect(
      validateStudy(STUDY_ID, "approved", undefined, USER_ID, IP),
    ).rejects.toMatchObject({ status: 500 });
  });
});

// ── correctStudyValidation ────────────────────────────────────────────────────

describe("correctStudyValidation", () => {
  it("links the new record to the prior validation via correctsId", async () => {
    mockValidationRepo.findLatestValidation.mockResolvedValue(RECORD);
    const correctedRecord = { ...RECORD, validationId: 2, correctsId: 1 };
    mockValidationRepo.insertValidation.mockResolvedValue(correctedRecord);

    const result = await correctStudyValidation(
      STUDY_ID,
      "approved",
      undefined,
      USER_ID,
      IP,
    );

    expect(mockValidationRepo.insertValidation).toHaveBeenCalledWith(
      expect.objectContaining({ correctsId: 1 }),
    );
    expect(result.validationId).toBe(2);
  });

  it("throws 404 when there is no prior validation to correct", async () => {
    mockValidationRepo.findLatestValidation.mockResolvedValue(null);

    await expect(
      correctStudyValidation(STUDY_ID, "approved", undefined, USER_ID, IP),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when action is rejected and comment is missing", async () => {
    mockValidationRepo.findLatestValidation.mockResolvedValue(RECORD);

    await expect(
      correctStudyValidation(STUDY_ID, "rejected", undefined, USER_ID, IP),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("wraps unexpected DB errors as 500", async () => {
    mockValidationRepo.findLatestValidation.mockResolvedValue(RECORD);
    mockValidationRepo.insertValidation.mockRejectedValue(new Error("DB down"));

    await expect(
      correctStudyValidation(STUDY_ID, "approved", undefined, USER_ID, IP),
    ).rejects.toMatchObject({ status: 500 });
  });
});
