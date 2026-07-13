/**
 * Unit tests for instances-util — ordering a study's instances for sequential
 * viewing. Pure logic, no I/O, runs under jest (npm test).
 */
import {
  orderInstances,
  buildInstancesPayload,
  type InstanceRow,
} from "./instances-util";

const row = (
  id: number,
  instance_number: number | null,
  orthanc_instance_id = `o${id}`,
): InstanceRow => ({
  id,
  instance_number,
  orthanc_instance_id,
});

describe("orderInstances", () => {
  it("orders by InstanceNumber numerically (2 before 10)", () => {
    const input = [row(1, 10), row(2, 2), row(3, 1), row(4, 100)];
    expect(orderInstances(input).map((r) => r.instance_number)).toEqual([
      1, 2, 10, 100,
    ]);
  });

  it("sorts rows without an InstanceNumber last", () => {
    const input = [row(1, null), row(2, 5), row(3, null), row(4, 1)];
    expect(orderInstances(input).map((r) => r.instance_number)).toEqual([
      1,
      5,
      null,
      null,
    ]);
  });

  it("breaks InstanceNumber ties by insertion id (upload order)", () => {
    const input = [row(30, 1), row(10, 1), row(20, 1)];
    expect(orderInstances(input).map((r) => r.id)).toEqual([10, 20, 30]);
  });

  it("keeps id order among rows with no InstanceNumber", () => {
    const input = [row(30, null), row(10, null), row(20, null)];
    expect(orderInstances(input).map((r) => r.id)).toEqual([10, 20, 30]);
  });

  it("does not mutate the input array", () => {
    const input = [row(1, 2), row(2, 1)];
    const snapshot = input.map((r) => r.id);
    orderInstances(input);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("buildInstancesPayload", () => {
  it("returns the ordered instance list with a count", () => {
    const input = [row(1, 3, "a"), row(2, 1, "b"), row(3, 2, "c")];
    expect(buildInstancesPayload("study-xyz", input)).toEqual({
      studyId: "study-xyz",
      count: 3,
      instances: [
        { instanceId: "b", instanceNumber: 1 },
        { instanceId: "c", instanceNumber: 2 },
        { instanceId: "a", instanceNumber: 3 },
      ],
    });
  });

  it("handles a study with no instances", () => {
    expect(buildInstancesPayload("empty", [])).toEqual({
      studyId: "empty",
      count: 0,
      instances: [],
    });
  });
});
