/**
 * Contract test: a real response recorded from the MICD_TRAINING inference
 * service (MedSAM3 path, POST /segmentation on a stored CT). If the service's
 * contract drifts, re-record this fixture — and this test says whether the
 * backend still accepts it.
 */
import { describe, it, expect } from "@jest/globals";
import fixture from "../../fixtures/inference-segmentation-response.json";
import { parseInferenceResult } from "../../../src/clients/inference.client";

describe("inference service contract", () => {
  it("accepts the recorded real response unchanged", () => {
    const parsed = parseInferenceResult(fixture);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(fixture);
  });

  it("the recorded response is a real-model one, labelled as such", () => {
    const parsed = parseInferenceResult(fixture)!;
    expect(parsed.simulated).toBe(false);
    expect(parsed.modelVersion).toMatch(/@sha256:[0-9a-f]{12}$/);
    expect(parsed.derived.derivationDescription).not.toMatch(/simulada/i);
  });
});
