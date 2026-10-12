import { parseClassificationId } from "../../../src/modules/upload/classification";
import { isHttpError } from "../../../src/shared/http-error";

describe("parseClassificationId", () => {
  it("returns null for absent or blank values", () => {
    expect(parseClassificationId(undefined)).toBeNull();
    expect(parseClassificationId(null)).toBeNull();
    expect(parseClassificationId("")).toBeNull();
    expect(parseClassificationId("   ")).toBeNull();
  });

  it("parses a positive integer id", () => {
    expect(parseClassificationId("3")).toBe(3);
    expect(parseClassificationId("42")).toBe(42);
    expect(parseClassificationId(7)).toBe(7);
    expect(parseClassificationId("  5 ")).toBe(5);
  });

  it.each(["abc", "1.5", "-2", "0", "3x", "1e3", "3 4"])(
    "rejects %p with an HttpError 400 (no free text)",
    (bad) => {
      try {
        parseClassificationId(bad);
        throw new Error("expected parseClassificationId to throw");
      } catch (err) {
        expect(isHttpError(err)).toBe(true);
        expect((err as { status: number }).status).toBe(400);
      }
    },
  );
});
