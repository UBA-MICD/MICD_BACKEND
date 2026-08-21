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

  /**
   * Anonymized DICOM bytes for an instance — for investigador downloads. Orthanc
   * strips PHI tags (PatientName/ID, dates, physician/institution, private tags)
   * and returns the DICOM in the response body WITHOUT persisting a new resource
   * (verified against Orthanc 24.1.2). The study/series/SOP UIDs are kept (Force
   * is required to keep identifying UIDs) so the viewer can still stack a study's
   * slices into a volume — UIDs are opaque identifiers, not patient identity.
   */
  anonymizeInstance: (id: string): Promise<AxiosResponse<ArrayBuffer>> =>
    axios.post<ArrayBuffer>(
      `${BASE}/instances/${id}/anonymize`,
      {
        Keep: ["StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID"],
        Force: true,
        KeepPrivateTags: false,
      },
      { auth, responseType: "arraybuffer" },
    ),

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

  /** Like postInstance but accepts a readable stream (Zenodo import pipe). */
  postInstanceStream: (data: NodeJS.ReadableStream): Promise<AxiosResponse> =>
    axios.post(`${BASE}/instances`, data, {
      auth,
      headers: { "Content-Type": "application/dicom" },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }),

  getInstanceTags: (id: string): Promise<AxiosResponse> =>
    axios.get(`${BASE}/instances/${id}/tags`, { auth }),

  deleteInstance: (id: string): Promise<AxiosResponse> =>
    axios.delete(`${BASE}/instances/${id}`, { auth }),
};
