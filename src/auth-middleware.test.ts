import { Request, Response } from "express";
import { requireAuth } from "./auth-middleware";
import { signAccessToken } from "./services/jwt.service";

const PAYLOAD = { sub: 1, email: "user@micd.local" };

function makeRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(header?: string): Request {
  return {
    headers: header ? { authorization: header } : {},
  } as unknown as Request;
}

describe("requireAuth", () => {
  it("calls next() and attaches req.user for a valid token", () => {
    const token = signAccessToken(PAYLOAD);
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).user).toMatchObject(PAYLOAD);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("responds 401 when the Authorization header is missing", () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("responds 401 when the header is malformed (no Bearer prefix)", () => {
    const token = signAccessToken(PAYLOAD);
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("responds 401 for an expired token", () => {
    const expired = signAccessToken(PAYLOAD, { expiresIn: "-1s" });
    const req = makeReq(`Bearer ${expired}`);
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("responds 401 for a tampered token", () => {
    const token = signAccessToken(PAYLOAD);
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    const req = makeReq(`Bearer ${tampered}`);
    const res = makeRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
