import axios from "axios";
import { orthancClient } from "../../../src/clients/orthanc.client";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const AUTH = expect.objectContaining({
  auth: { username: "orthanc", password: "orthanc" },
});

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
      "http://orthanc:8042/system",
      expect.objectContaining({ timeout: 3000 }),
    );
  });

  it("listStudies / getStudy / deleteStudy hit the studies routes with auth", async () => {
    await orthancClient.listStudies();
    expect(mockedAxios.get).toHaveBeenCalledWith("http://orthanc:8042/studies", AUTH);

    await orthancClient.getStudy("s1");
    expect(mockedAxios.get).toHaveBeenCalledWith("http://orthanc:8042/studies/s1", AUTH);

    await orthancClient.deleteStudy("s1");
    expect(mockedAxios.delete).toHaveBeenCalledWith("http://orthanc:8042/studies/s1", AUTH);
  });

  it("getInstanceFile and getInstancePreview request arraybuffers", async () => {
    await orthancClient.getInstanceFile("i1");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "http://orthanc:8042/instances/i1/file",
      expect.objectContaining({ responseType: "arraybuffer" }),
    );

    await orthancClient.getInstancePreview("i1");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "http://orthanc:8042/instances/i1/preview",
      expect.objectContaining({ responseType: "arraybuffer" }),
    );
  });

  it("postInstance sends a DICOM buffer with unlimited body length", async () => {
    const buf = Buffer.from("DICM");
    await orthancClient.postInstance(buf);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "http://orthanc:8042/instances",
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
      "http://orthanc:8042/instances",
      stream,
      expect.objectContaining({ maxBodyLength: Infinity, maxContentLength: Infinity }),
    );
  });

  it("getInstanceTags and deleteInstance hit the instance routes with auth", async () => {
    await orthancClient.getInstanceTags("i1");
    expect(mockedAxios.get).toHaveBeenCalledWith("http://orthanc:8042/instances/i1/tags", AUTH);

    await orthancClient.deleteInstance("i1");
    expect(mockedAxios.delete).toHaveBeenCalledWith("http://orthanc:8042/instances/i1", AUTH);
  });
});
