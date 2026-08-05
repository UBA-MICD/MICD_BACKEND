jest.mock("fs");
jest.mock("http");
jest.mock("https");

import fs from "fs";
import http from "http";
import https from "https";
import { createHttpServer } from "../../../src/shared/http-server";

const mockReadFileSync = fs.readFileSync as jest.Mock;
const mockHttpCreateServer = http.createServer as jest.Mock;
const mockHttpsCreateServer = https.createServer as jest.Mock;

const app = { fakeExpressApp: true } as any;

beforeEach(() => {
  mockReadFileSync.mockReset();
  mockHttpCreateServer.mockReset();
  mockHttpsCreateServer.mockReset();
});

describe("createHttpServer — TLS disabled", () => {
  it("returns a plain HTTP server and touches neither https nor the filesystem", () => {
    const fakeServer = { kind: "http" };
    mockHttpCreateServer.mockReturnValue(fakeServer);

    const server = createHttpServer(app, { enabled: false });

    expect(server).toBe(fakeServer);
    expect(mockHttpCreateServer).toHaveBeenCalledWith(app);
    expect(mockHttpsCreateServer).not.toHaveBeenCalled();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("ignores stray cert/key paths when TLS is disabled", () => {
    mockHttpCreateServer.mockReturnValue({});

    createHttpServer(app, {
      enabled: false,
      certPath: "/certs/tls.crt",
      keyPath: "/certs/tls.key",
    });

    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(mockHttpsCreateServer).not.toHaveBeenCalled();
  });
});

describe("createHttpServer — TLS enabled", () => {
  it("reads the configured cert/key and returns an HTTPS server built from them", () => {
    const fakeServer = { kind: "https" };
    mockReadFileSync.mockImplementation((path: string) =>
      path === "/certs/tls.crt" ? Buffer.from("CERT") : Buffer.from("KEY"),
    );
    mockHttpsCreateServer.mockReturnValue(fakeServer);

    const server = createHttpServer(app, {
      enabled: true,
      certPath: "/certs/tls.crt",
      keyPath: "/certs/tls.key",
    });

    expect(server).toBe(fakeServer);
    expect(mockReadFileSync).toHaveBeenCalledWith("/certs/tls.crt");
    expect(mockReadFileSync).toHaveBeenCalledWith("/certs/tls.key");
    expect(mockHttpsCreateServer).toHaveBeenCalledWith(
      { cert: Buffer.from("CERT"), key: Buffer.from("KEY") },
      app,
    );
    expect(mockHttpCreateServer).not.toHaveBeenCalled();
  });

  it("throws without touching the filesystem when certPath is missing", () => {
    expect(() =>
      createHttpServer(app, { enabled: true, keyPath: "/certs/tls.key" }),
    ).toThrow(/TLS_CERT_PATH and TLS_KEY_PATH must be set/);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("throws without touching the filesystem when keyPath is missing", () => {
    expect(() =>
      createHttpServer(app, { enabled: true, certPath: "/certs/tls.crt" }),
    ).toThrow(/TLS_CERT_PATH and TLS_KEY_PATH must be set/);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("throws when certPath and keyPath are both empty strings", () => {
    expect(() =>
      createHttpServer(app, { enabled: true, certPath: "", keyPath: "" }),
    ).toThrow(/TLS_CERT_PATH and TLS_KEY_PATH must be set/);
  });

  it("propagates the filesystem error instead of falling back to HTTP when the cert/key can't be read", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    expect(() =>
      createHttpServer(app, {
        enabled: true,
        certPath: "/certs/missing.crt",
        keyPath: "/certs/missing.key",
      }),
    ).toThrow(/ENOENT/);
    expect(mockHttpsCreateServer).not.toHaveBeenCalled();
    expect(mockHttpCreateServer).not.toHaveBeenCalled();
  });
});
