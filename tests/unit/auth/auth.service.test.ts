/**
 * Unit tests for auth.service — login, logout, and token refresh flows.
 * All collaborators (user store, password, jwt, refresh tokens) are mocked;
 * the real DB path is covered by the integration suite.
 */
import { HttpError } from "../../../src/shared/http-error";

jest.mock("../../../src/modules/auth/password.service");
jest.mock("../../../src/modules/auth/user.service");
jest.mock("../../../src/modules/auth/jwt.service");
jest.mock("../../../src/modules/auth/refresh-token.service");
jest.mock("../../../src/modules/auth/invite.service");
jest.mock("../../../src/shared/audit", () => ({
  AUDIT_ACTIONS: jest.requireActual("../../../src/shared/audit").AUDIT_ACTIONS,
  logAction: jest.fn().mockResolvedValue(undefined),
}));

import { verifyPassword } from "../../../src/modules/auth/password.service";
import {
  findUserByEmail,
  findUserById,
  stampLastLogin,
} from "../../../src/modules/auth/user.service";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  getTokenExpiry,
} from "../../../src/modules/auth/jwt.service";
import {
  storeRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
} from "../../../src/modules/auth/refresh-token.service";

import { login, logout, refresh } from "../../../src/modules/auth/auth.service";

// ── helpers ───────────────────────────────────────────────────────────────────

const makeUser = (over: Record<string, unknown> = {}) => ({
  id: 7,
  email: "u@micd.local",
  password: "$2b$hash",
  role: "medico" as const,
  status: "active",
  ...over,
});

async function expectHttpStatus(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toBeInstanceOf(HttpError);
  await expect(p).rejects.toHaveProperty("status", status);
}

// ── common setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Happy-path defaults — individual tests override as needed
  (verifyPassword as jest.Mock).mockResolvedValue(true);
  (findUserByEmail as jest.Mock).mockResolvedValue(makeUser());
  (findUserById as jest.Mock).mockResolvedValue(makeUser());
  (stampLastLogin as jest.Mock).mockResolvedValue(undefined);
  (signAccessToken as jest.Mock).mockReturnValue("access-token");
  (signRefreshToken as jest.Mock).mockReturnValue("refresh-token");
  (getTokenExpiry as jest.Mock).mockReturnValue(new Date());
  (storeRefreshToken as jest.Mock).mockResolvedValue(undefined);
  (revokeRefreshToken as jest.Mock).mockResolvedValue(undefined);
  (consumeRefreshToken as jest.Mock).mockResolvedValue({ id: 1, user_id: 7 });
  (verifyRefreshToken as jest.Mock).mockReturnValue({ sub: 7 });
});

// ── login ─────────────────────────────────────────────────────────────────────

describe("login — success", () => {
  it("returns access token, refresh token, and user shape", async () => {
    const result = await login("u@micd.local", "correctpw");
    expect(result).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user: { id: 7, email: "u@micd.local", role: "medico" },
    });
  });

  it("stamps last_login_at on a successful login", async () => {
    await login("u@micd.local", "correctpw");
    expect(stampLastLogin).toHaveBeenCalledWith(7);
  });

  it("persists the refresh token in the DB", async () => {
    await login("u@micd.local", "correctpw");
    expect(storeRefreshToken).toHaveBeenCalledWith(
      7,
      "refresh-token",
      expect.any(Date),
    );
  });

  it("signs the access token with the user's sub, email, and role", async () => {
    await login("u@micd.local", "correctpw");
    expect(signAccessToken).toHaveBeenCalledWith({
      sub: 7,
      email: "u@micd.local",
      role: "medico",
    });
  });
});

describe("login — wrong password", () => {
  it("rejects with 401 when verifyPassword returns false", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(false);
    await expectHttpStatus(login("u@micd.local", "badpw"), 401);
  });

  it("does not stamp or store tokens on a failed password check", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(false);
    await login("u@micd.local", "badpw").catch(() => undefined);
    expect(stampLastLogin).not.toHaveBeenCalled();
    expect(storeRefreshToken).not.toHaveBeenCalled();
  });
});

describe("login — unknown email", () => {
  it("rejects with 401 when the user does not exist", async () => {
    (findUserByEmail as jest.Mock).mockResolvedValue(null);
    // verifyPassword is still called (against DUMMY_HASH) to prevent timing oracle
    await expectHttpStatus(login("ghost@micd.local", "pw"), 401);
  });

  it("uses a generic error so callers cannot distinguish unknown email from wrong password", async () => {
    (findUserByEmail as jest.Mock).mockResolvedValue(null);
    await expect(login("ghost@micd.local", "pw")).rejects.toMatchObject({
      body: { error: "Invalid email or password" },
    });
  });
});

describe("login — blocked / deleted accounts", () => {
  it.each(["blocked", "deleted"] as const)(
    "refuses a %s account with a generic 401",
    async (status) => {
      (findUserByEmail as jest.Mock).mockResolvedValue(makeUser({ status }));
      await expect(login("u@micd.local", "pw")).rejects.toMatchObject({
        status: 401,
        body: { error: "Invalid email or password" },
      });
    },
  );

  it("does not stamp or mint tokens for a blocked account", async () => {
    (findUserByEmail as jest.Mock).mockResolvedValue(
      makeUser({ status: "blocked" }),
    );
    await login("u@micd.local", "pw").catch(() => undefined);
    expect(stampLastLogin).not.toHaveBeenCalled();
    expect(storeRefreshToken).not.toHaveBeenCalled();
  });
});

// ── logout ────────────────────────────────────────────────────────────────────

describe("logout", () => {
  it("delegates to revokeRefreshToken with the supplied token", async () => {
    await logout("some-refresh-token");
    expect(revokeRefreshToken).toHaveBeenCalledWith("some-refresh-token");
  });

  it("resolves without throwing even when revokeRefreshToken is a no-op", async () => {
    (revokeRefreshToken as jest.Mock).mockResolvedValue(undefined);
    await expect(logout("token")).resolves.toBeUndefined();
  });
});

// ── refresh ───────────────────────────────────────────────────────────────────

describe("refresh — success", () => {
  it("returns a new access token and a new refresh token", async () => {
    (signRefreshToken as jest.Mock).mockReturnValue("new-refresh-token");
    (signAccessToken as jest.Mock).mockReturnValue("new-access-token");

    const result = await refresh("old-refresh-token");
    expect(result).toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
    });
  });

  it("consumes the old refresh token atomically", async () => {
    await refresh("old-refresh-token");
    expect(consumeRefreshToken).toHaveBeenCalledWith("old-refresh-token");
  });

  it("stores the new refresh token in the DB", async () => {
    (signRefreshToken as jest.Mock).mockReturnValue("new-refresh");
    await refresh("old-refresh-token");
    expect(storeRefreshToken).toHaveBeenCalledWith(
      7,
      "new-refresh",
      expect.any(Date),
    );
  });
});

describe("refresh — invalid / expired token", () => {
  it("rejects with 401 when verifyRefreshToken throws (signature invalid)", async () => {
    (verifyRefreshToken as jest.Mock).mockImplementation(() => {
      throw new Error("invalid signature");
    });
    await expectHttpStatus(refresh("bad-token"), 401);
  });

  it("rejects with 401 when verifyRefreshToken throws (token expired)", async () => {
    (verifyRefreshToken as jest.Mock).mockImplementation(() => {
      throw new Error("jwt expired");
    });
    await expectHttpStatus(refresh("expired-token"), 401);
  });

  it("rejects with 401 when the token has already been consumed", async () => {
    (consumeRefreshToken as jest.Mock).mockResolvedValue(null);
    await expectHttpStatus(refresh("used-token"), 401);
  });

  it("rejects with 401 when the associated user no longer exists", async () => {
    (findUserById as jest.Mock).mockResolvedValue(null);
    await expectHttpStatus(refresh("orphan-token"), 401);
  });

  it("uses a generic error body for all refresh failures", async () => {
    (consumeRefreshToken as jest.Mock).mockResolvedValue(null);
    await expect(refresh("used")).rejects.toMatchObject({
      body: { error: "Invalid or expired refresh token" },
    });
  });
});
