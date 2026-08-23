import axios, { AxiosResponse } from "axios";
import { orthancConfig } from "../config/env";

/**
 * Thin wrapper around Orthanc's REST API. This is the single place the backend
 * talks to Orthanc — the admin basic-auth credentials live here and never leak
 * to callers. Methods return the raw axios response so the service layer can
 * map Orthanc's status codes to domain errors.
 */
const BASE = orthancConfig.url;
const auth = orthancConfig.auth;

/**
 * Every request below carries Orthanc's admin credentials, so an id must stay
 * a single path segment and never open a new one. Callers are expected to
 * validate ids (see shared/orthanc-id.ts); escaping here means even a caller
 * that forgets cannot turn an id into a different Orthanc endpoint. This is a
 * no-op for well-formed ids, which are only hex and dashes.
 */
const seg = (id: string): string => encodeURIComponent(id);

export const orthancClient = {
  getSystem: (): Promise<AxiosResponse> =>
    axios.get(`${BASE}/system`, { auth, timeout: 3000 }),

  listStudies: (): Promise<AxiosResponse> =>
    axios.get(`${BASE}/studies`, { auth }),

  getStudy: (id: string): Promise<AxiosResponse> =>
    axios.get(`${BASE}/studies/${seg(id)}`, { auth }),

  deleteStudy: (id: string): Promise<AxiosResponse> =>
    axios.delete(`${BASE}/studies/${seg(id)}`, { auth }),

  getInstanceFile: (id: string): Promise<AxiosResponse<ArrayBuffer>> =>
    axios.get<ArrayBuffer>(`${BASE}/instances/${seg(id)}/file`, {
      auth,
      responseType: "arraybuffer",
    }),

  getInstancePreview: (id: string): Promise<AxiosResponse<ArrayBuffer>> =>
    axios.get<ArrayBuffer>(`${BASE}/instances/${seg(id)}/preview`, {
      auth,
      responseType: "arraybuffer",
    }),

  postInstance: (buffer: Buffer): Promise<AxiosResponse> =>
    axios.post(`${BASE}/instances`, buffer, {
      auth,
      headers: { "Content-Type": "application/dicom" },
      maxBodyLength: Infinity,
    }),

  /** Like postInstance but accepts a readable stream (Zenodo import pipe). */
  postInstanceStream: (data: NodeJS.ReadableStream): Promise<AxiosResponse> =>
    axios.post(`${BASE}/instances`, data, {
      auth,
      headers: { "Content-Type": "application/dicom" },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }),

  getInstanceTags: (id: string): Promise<AxiosResponse> =>
    axios.get(`${BASE}/instances/${seg(id)}/tags`, { auth }),

  deleteInstance: (id: string): Promise<AxiosResponse> =>
    axios.delete(`${BASE}/instances/${seg(id)}`, { auth }),
};
