/**
 * Orthanc resource ids taken from the URL are interpolated into requests that
 * carry Orthanc's admin credentials, so the validator's job is to reject
 * anything that could steer that URL somewhere else — traversal, a new path
 * segment, a query string — before it ever reaches the client.
 */
import {
  isValidOrthancId,
  assertValidOrthancId,
} from "../../../src/shared/orthanc-id";
import { isHttpError } from "../../../src/shared/http-error";

describe("isValidOrthancId", () => {
  it.each([
    ["a real Orthanc id", "2f2ac6ff-a1b2c3d4-5e6f7a8b-9c0d1e2f-3a4b5c6d"],
    ["a bare hex string", "0123456789abcdef"],
    ["uppercase hex", "ABCDEF01-23456789"],
  ])("accepts %s", (_label, id) => {
    expect(isValidOrthancId(id)).toBe(true);
  });

  it.each([
    ["path traversal", "../../tools/execute-script"],
    ["a bare parent segment", ".."],
    ["an embedded slash", "abc/def"],
    ["a decoded percent-escape", "..%2f..%2ftools"],
    ["a query string", "abc?param=1"],
    ["a fragment", "abc#frag"],
    ["a non-hex letter", "zzzzzzzz"],
    ["whitespace", "abc def"],
    ["an empty string", ""],
    ["a dangling dash", "abcdef-"],
  ])("rejects %s", (_label, id) => {
    expect(isValidOrthancId(id)).toBe(false);
  });

  it("rejects an absurdly long id", () => {
    expect(isValidOrthancId("a".repeat(500))).toBe(false);
  });
});

describe("assertValidOrthancId", () => {
  it("passes a valid id through without throwing", () => {
    expect(() => assertValidOrthancId("0123456789abcdef")).not.toThrow();
  });

  it("throws a 400 HttpError for an invalid id", () => {
    let caught: unknown;
    try {
      assertValidOrthancId("../../tools/execute-script");
    } catch (err) {
      caught = err;
    }

    expect(isHttpError(caught)).toBe(true);
    expect((caught as { status: number }).status).toBe(400);
  });
});
