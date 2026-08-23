import axios from "axios";
import { orthancClient } from "../../../src/clients/orthanc.client";
import { orthancConfig } from "../../../src/config/env";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// The client builds URLs and credentials from config (ORTHANC_URL etc.), which
// differs between local and CI — assert against the same config, never a
// hardcoded hostname.
const BASE = orthancConfig.url;
const AUTH = expect.objectContaining({ auth: orthancConfig.auth });

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get.mockResolvedValue({ data: {} } as any);
  mockedAxios.post.mockResolvedValue({ data: {} } as any);
  mockedAxios.delete.mockResolvedValue({ data: {} } as any);
});

describe("orthancClient", () => {
  it("getSystem probes /system with a short timeout", async () => {
    await orthancClient.getSystem();
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${BASE}/system`,
      expect.objectContaining({ timeout: 3000 }),
    );
  });

  it("listStudies / getStudy / deleteStudy hit the studies routes with auth", async () => {
    await orthancClient.listStudies();
    expect(mockedAxios.get).toHaveBeenCalledWith(`${BASE}/studies`, AUTH);

    await orthancClient.getStudy("s1");
    expect(mockedAxios.get).toHaveBeenCalledWith(`${BASE}/studies/s1`, AUTH);

    await orthancClient.deleteStudy("s1");
    expect(mockedAxios.delete).toHaveBeenCalledWith(`${BASE}/studies/s1`, AUTH);
  });

  it("getInstanceFile and getInstancePreview request arraybuffers", async () => {
    await orthancClient.getInstanceFile("i1");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${BASE}/instances/i1/file`,
      expect.objectContaining({ responseType: "arraybuffer" }),
    );

    await orthancClient.getInstancePreview("i1");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${BASE}/instances/i1/preview`,
      expect.objectContaining({ responseType: "arraybuffer" }),
    );
  });

  it("postInstance sends a DICOM buffer with unlimited body length", async () => {
    const buf = Buffer.from("DICM");
    await orthancClient.postInstance(buf);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${BASE}/instances`,
      buf,
      expect.objectContaining({
        headers: { "Content-Type": "application/dicom" },
        maxBodyLength: Infinity,
      }),
    );
  });

  it("postInstanceStream also lifts the response size limit", async () => {
    const stream = { pipe: jest.fn() } as unknown as NodeJS.ReadableStream;
    await orthancClient.postInstanceStream(stream);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${BASE}/instances`,
      stream,
      expect.objectContaining({ maxBodyLength: Infinity, maxContentLength: Infinity }),
    );
  });

  it("getInstanceTags and deleteInstance hit the instance routes with auth", async () => {
    await orthancClient.getInstanceTags("i1");
    expect(mockedAxios.get).toHaveBeenCalledWith(`${BASE}/instances/i1/tags`, AUTH);

    await orthancClient.deleteInstance("i1");
    expect(mockedAxios.delete).toHaveBeenCalledWith(`${BASE}/instances/i1`, AUTH);
  });

  // Callers are expected to validate ids first, but these requests carry
  // Orthanc's admin credentials, so the client escapes them too: an id must
  // stay one path segment and can never open a new one.
  it("escapes ids so they cannot break out of their path segment", async () => {
    await orthancClient.getStudy("../../tools/execute-script");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${BASE}/studies/..%2F..%2Ftools%2Fexecute-script`,
      AUTH,
    );

    await orthancClient.getInstanceFile("a/b");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${BASE}/instances/a%2Fb/file`,
      expect.objectContaining({ responseType: "arraybuffer" }),
    );
  });
});
