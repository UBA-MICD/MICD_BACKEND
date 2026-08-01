import axios from "axios";
import {
  zenodoClient,
  ZenodoNotConfiguredError,
} from "../../../src/clients/zenodo.client";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const SANDBOX_BASE = "https://sandbox.zenodo.org/api";
const PRODUCTION_BASE = "https://zenodo.org/api";

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("environment base URL", () => {
  it("targets sandbox.zenodo.org in sandbox mode", async () => {
    mockedAxios.get.mockResolvedValue({ data: {} } as any);
    await zenodoClient.getRecord(1, "tok", "sandbox");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${SANDBOX_BASE}/records/1`,
      expect.anything(),
    );
  });

  it("targets zenodo.org in production mode", async () => {
    mockedAxios.get.mockResolvedValue({ data: {} } as any);
    await zenodoClient.getRecord(1, "tok", "production");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${PRODUCTION_BASE}/records/1`,
      expect.anything(),
    );
  });
});

describe("429 handling", () => {
  it("waits for the Retry-After header (seconds) then retries and resolves", async () => {
    jest.useFakeTimers();
    mockedAxios.get
      .mockRejectedValueOnce({ response: { status: 429, headers: { "retry-after": "2" } } })
      .mockResolvedValueOnce({ data: { id: 1 } } as any);

    const p = zenodoClient.getRecord(1, "tok", "production");
    await jest.advanceTimersByTimeAsync(2000);
    const result = await p;

    expect(result.data).toEqual({ id: 1 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it("falls back to a default wait when Retry-After is missing", async () => {
    jest.useFakeTimers();
    mockedAxios.get
      .mockRejectedValueOnce({ response: { status: 429, headers: {} } })
      .mockResolvedValueOnce({ data: { id: 1 } } as any);

    const p = zenodoClient.getRecord(1, "tok", "production");
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ data: { id: 1 } });
  });
});

describe("5xx handling", () => {
  it("backs off exponentially and eventually resolves within the retry budget", async () => {
    jest.useFakeTimers();
    mockedAxios.get
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 502 } })
      .mockResolvedValueOnce({ data: { id: 1 } } as any);

    const p = zenodoClient.getRecord(1, "tok", "production");
    await jest.advanceTimersByTimeAsync(1000); // after 1st failure
    await jest.advanceTimersByTimeAsync(2000); // after 2nd failure
    const result = await p;

    expect(result.data).toEqual({ id: 1 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  it("gives up and rethrows after exhausting the retry budget", async () => {
    jest.useFakeTimers();
    mockedAxios.get.mockRejectedValue({ response: { status: 500 } });

    const p = zenodoClient.getRecord(1, "tok", "production");
    p.catch(() => {}); // avoid an unhandled-rejection warning while timers advance
    await jest.runAllTimersAsync();

    await expect(p).rejects.toMatchObject({ response: { status: 500 } });
    // 1 initial attempt + 3 retries = 4 total calls
    expect(mockedAxios.get).toHaveBeenCalledTimes(4);
  });
});

describe("non-retryable errors", () => {
  it("rejects immediately on a 4xx without sleeping or retrying", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 400 } });

    await expect(zenodoClient.getRecord(1, "tok", "production")).rejects.toMatchObject({
      response: { status: 400 },
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
});

describe("ZenodoNotConfiguredError", () => {
  const authRequiredCalls: [string, () => Promise<unknown>][] = [
    ["createDeposition", () => zenodoClient.createDeposition(null, "sandbox")],
    [
      "setDepositionMetadata",
      () => zenodoClient.setDepositionMetadata(null, "sandbox", 1, {}),
    ],
    [
      "uploadFileToBucket",
      () =>
        zenodoClient.uploadFileToBucket(null, "https://bucket", "f.dcm", Buffer.from("x"), "sandbox"),
    ],
    ["publishDeposition", () => zenodoClient.publishDeposition(null, "sandbox", 1)],
    ["listFiles", () => zenodoClient.listFiles(null, "sandbox", 1)],
    ["newVersion", () => zenodoClient.newVersion(null, "sandbox", 1)],
  ];

  it.each(authRequiredCalls)("%s throws without making an HTTP call when token is missing", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(ZenodoNotConfiguredError);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });
});

describe("listFiles", () => {
  it("GETs the deposition files endpoint with the bearer token", async () => {
    mockedAxios.get.mockResolvedValue({ data: [] } as any);
    await zenodoClient.listFiles("tok", "production", 42);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${PRODUCTION_BASE}/deposit/depositions/42/files`,
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
  });
});

describe("newVersion", () => {
  it("POSTs to the newversion action endpoint with the bearer token", async () => {
    mockedAxios.post.mockResolvedValue({ data: {} } as any);
    await zenodoClient.newVersion("tok", "production", 42);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${PRODUCTION_BASE}/deposit/depositions/42/actions/newversion`,
      {},
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
  });
});
