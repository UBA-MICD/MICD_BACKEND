/**
 * instances-util.ts — pure helpers for listing a study's instances in the
 * order a viewer should scroll through them.
 *
 * Kept free of express/axios/pg so it can be unit-tested without those deps.
 */

/** One DICOM instance row as stored in the `studies` table. */
export interface InstanceRow {
  id: number;
  orthanc_instance_id: string;
  /** DICOM InstanceNumber (0020,0013); null for rows uploaded before it was tracked. */
  instance_number: number | null;
}

export interface InstancesPayload {
  studyId: string;
  count: number;
  instances: Array<{ instanceId: string; instanceNumber: number | null }>;
}

/**
 * Order instances for sequential viewing: by DICOM InstanceNumber ascending,
 * rows without one go last, ties broken by insertion id (upload order).
 * Pure — never mutates the input.
 */
export function orderInstances<T extends InstanceRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const an = a.instance_number;
    const bn = b.instance_number;
    if (an !== bn) {
      if (an === null) return 1; // a has no number → after b
      if (bn === null) return -1; // b has no number → after a
      return an - bn;
    }
    return a.id - b.id;
  });
}

/** Build the API payload for GET /studies/:studyId/instances. */
export function buildInstancesPayload(
  studyId: string,
  rows: readonly InstanceRow[],
): InstancesPayload {
  const ordered = orderInstances(rows);
  return {
    studyId,
    count: ordered.length,
    instances: ordered.map((r) => ({
      instanceId: r.orthanc_instance_id,
      instanceNumber: r.instance_number,
    })),
  };
}
