import { HttpError } from "./http-error";

/**
 * Validation for Orthanc resource ids that arrive from the URL.
 *
 * Orthanc ids are hex groups joined by dashes
 * (e.g. 2f2ac6ff-a1b2c3d4-5e6f7a8b-9c0d1e2f-3a4b5c6d). Requests to Orthanc
 * carry its admin basic-auth, so an id that is allowed to contain a slash, a
 * dot segment or a query string stops being an identifier and becomes a way to
 * pick which Orthanc endpoint the backend calls on the caller's behalf.
 * Constraining the alphabet removes that whole class of input.
 */
const ORTHANC_ID = /^[0-9a-fA-F]+(-[0-9a-fA-F]+)*$/;

// Real ids are 44 chars; the bound just keeps a pathological string from
// reaching the regex.
const MAX_LENGTH = 128;

export function isValidOrthancId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_LENGTH &&
    ORTHANC_ID.test(id)
  );
}

/** Throws a 400 HttpError unless `id` is a well-formed Orthanc resource id. */
export function assertValidOrthancId(id: string): void {
  if (!isValidOrthancId(id)) {
    throw new HttpError(400, { error: "Invalid Orthanc resource id" });
  }
}
