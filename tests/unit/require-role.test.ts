import { Request, Response } from "express";
import { requireRole } from "../../src/middleware/auth.middleware";
import { HttpError } from "../../src/shared/http-error";
import { ROLES, Role } from "../../src/shared/roles";

function makeRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(user?: { sub: number; email: string; role: unknown }): Request {
  return { user } as unknown as Request;
}

const req = (role: unknown) =>
  makeReq({ sub: 1, email: "u@micd.local", role });

describe("requireRole", () => {
  it("calls next() with no error when the role is allowed", () => {
    const next = jest.fn();
    const res = makeRes();
    requireRole("admin", "medico")(req("medico"), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error argument
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(ROLES)("admits %s to a guard that lists it", (role: Role) => {
    const next = jest.fn();
    requireRole(role)(req(role), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it("forwards a 403 HttpError when the role is not allowed", () => {
    const next = jest.fn();
    const res = makeRes();
    requireRole("admin")(req("investigador"), res, next);

    expect(res.status).not.toHaveBeenCalled(); // goes through next(err), not res
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.body).toEqual({
      error: "Forbidden",
      detail: "Requires role: admin",
    });
  });

  it("responds 401 (not 403) when req.user is missing — lets authFetch refresh", () => {
    const next = jest.fn();
    const res = makeRes();
    requireRole("admin")(makeReq(undefined), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown role string", "superuser"],
    ["missing role", undefined],
    ["wrong type", 42],
  ])("responds 401 for an invalid role claim (%s)", (_label, role) => {
    const next = jest.fn();
    const res = makeRes();
    requireRole("admin")(req(role), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("exposes the allowed roles for route-matrix introspection", () => {
    const guard = requireRole("admin", "medico");
    expect(guard.roles).toEqual(["admin", "medico"]);
  });
});
