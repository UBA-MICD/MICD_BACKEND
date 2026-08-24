/**
 * The legacy /api/studies/:id proxy is the one path that puts a caller-supplied
 * id straight into an Orthanc URL, and those requests carry Orthanc's admin
 * basic-auth. These cases pin the guard: a malformed id must be rejected before
 * the client is called at all, so nothing can be steered onto another Orthanc
 * endpoint.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("../../src/clients/orthanc.client", () => ({
  orthancClient: {
    listStudies: jest.fn(),
    getStudy: jest.fn(),
    deleteStudy: jest.fn(),
  },
}));

import {
  getOrthancStudy,
  deleteOrthancStudy,
} from "../../src/modules/studies/studies.service";
import { isHttpError } from "../../src/shared/http-error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { orthancClient } = jest.requireMock("../../src/clients/orthanc.client") as any;

const VALID_ID = "2f2ac6ff-a1b2c3d4-5e6f7a8b-9c0d1e2f-3a4b5c6d";

const MALICIOUS_IDS = [
  "../../tools/execute-script",
  "..",
  "abc/def",
  "..%2f..%2ftools",
  "abc?param=1",
];

beforeEach(() => {
  jest.clearAllMocks();
  orthancClient.getStudy.mockResolvedValue({ data: { ID: VALID_ID } });
  orthancClient.deleteStudy.mockResolvedValue({ data: {} });
});

describe("getOrthancStudy", () => {
  it("forwards a well-formed id to Orthanc", async () => {
    await expect(getOrthancStudy(VALID_ID)).resolves.toEqual({ ID: VALID_ID });
    expect(orthancClient.getStudy).toHaveBeenCalledWith(VALID_ID);
  });

  it.each(MALICIOUS_IDS)("rejects %j with a 400 and never calls Orthanc", async (id) => {
    let caught: unknown;
    try {
      await getOrthancStudy(id);
    } catch (err) {
      caught = err;
    }

    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(400);
    expect(orthancClient.getStudy).not.toHaveBeenCalled();
  });
});

describe("deleteOrthancStudy", () => {
  it("forwards a well-formed id to Orthanc", async () => {
    await deleteOrthancStudy(VALID_ID);
    expect(orthancClient.deleteStudy).toHaveBeenCalledWith(VALID_ID);
  });

  it.each(MALICIOUS_IDS)("rejects %j with a 400 and never calls Orthanc", async (id) => {
    let caught: unknown;
    try {
      await deleteOrthancStudy(id);
    } catch (err) {
      caught = err;
    }

    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(400);
    expect(orthancClient.deleteStudy).not.toHaveBeenCalled();
  });
});
