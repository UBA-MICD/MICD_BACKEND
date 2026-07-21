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

export const orthancClient = {
  getSystem: (): Promise<AxiosResponse> =>
    axios.get(`${BASE}/system`, { auth, timeout: 3000 }),

  listStudies: (): Promise<AxiosResponse> =>
    axios.get(`${BASE}/studies`, { auth }),

  getStudy: (id: string): Promise<AxiosResponse> =>
    axios.get(`${BASE}/studies/${id}`, { auth }),

  deleteStudy: (id: string): Promise<AxiosResponse> =>
    axios.delete(`${BASE}/studies/${id}`, { auth }),

  getInstanceFile: (id: string): Promise<AxiosResponse<ArrayBuffer>> =>
    axios.get<ArrayBuffer>(`${BASE}/instances/${id}/file`, {
      auth,
      responseType: "arraybuffer",
    }),

  getInstancePreview: (id: string): Promise<AxiosResponse<ArrayBuffer>> =>
    axios.get<ArrayBuffer>(`${BASE}/instances/${id}/preview`, {
      auth,
      responseType: "arraybuffer",
    }),

  postInstance: (buffer: Buffer): Promise<AxiosResponse> =>
    axios.post(`${BASE}/instances`, buffer, {
      auth,
      headers: { "Content-Type": "application/dicom" },
      maxBodyLength: Infinity,
    }),

  getInstanceTags: (id: string): Promise<AxiosResponse> =>
    axios.get(`${BASE}/instances/${id}/tags`, { auth }),
};
