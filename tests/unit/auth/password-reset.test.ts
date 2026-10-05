/**
 * Unit tests for auth.service's password recovery (requestPasswordReset,
 * getResetEmail, resetPassword). Collaborators are mocked so this is a pure
 * unit test; the real DB path is covered by the integration suite.
 */
import { HttpError } from "../../../src/shared/http-error";

jest.mock("../../../src/modules/auth/password-reset.service");
jest.mock("../../../src/modules/auth/password.service");
jest.mock("../../../src/modules/auth/user.service");
jest.mock("../../../src/modules/auth/jwt.service");
jest.mock("../../../src/modules/auth/refresh-token.service");
jest.mock("../../../src/shared/mailer");
jest.mock("../../../src/shared/audit", () => ({
  AUDIT_ACTIONS: jest.requireActual("../../../src/shared/audit").AUDIT_ACTIONS,
  logAction: jest.fn().mockResolvedValue(undefined),
}));

import {
  issueReset,
  findValidReset,
  consumeReset,
  consumeAllResetsForUser,
} from "../../../src/modules/auth/password-reset.service";
import {
  validatePasswordStrength,
  hashPassword,
} from "../../../src/modules/auth/password.service";
import {
  findUserByEmail,
  findUserById,
  setPassword,
  stampLastLogin,
} from "../../../src/modules/auth/user.service";
import {
  signAccessToken,
  signRefreshToken,
  getTokenExpiry,
} from "../../../src/modules/auth/jwt.service";
import {
  storeRefreshToken,
  revokeAllRefreshTokensForUser,
} from "../../../src/modules/auth/refresh-token.service";
import { sendPasswordReset } from "../../../src/shared/mailer";
import { logAction } from "../../../src/shared/audit";
import {
  requestPasswordReset,
  getResetEmail,
  resetPassword,
} from "../../../src/modules/auth/auth.service";

const activeUser = {
  id: 7,
  email: "user@micd.local",
  password: "old-hash",
  role: "medico",
  status: "active",
};

beforeEach(() => {
  jest.clearAllMocks();
  (validatePasswordStrength as jest.Mock).mockImplementation(() => undefined);
  (hashPassword as jest.Mock).mockResolvedValue("new-hash");
  (issueReset as jest.Mock).mockResolvedValue("the-code");
  (sendPasswordReset as jest.Mock).mockResolvedValue(undefined);
  (setPassword as jest.Mock).mockResolvedValue(undefined);
  (stampLastLogin as jest.Mock).mockResolvedValue(undefined);
  (revokeAllRefreshTokensForUser as jest.Mock).mockResolvedValue(undefined);
  (consumeAllResetsForUser as jest.Mock).mockResolvedValue(undefined);
  (signAccessToken as jest.Mock).mockReturnValue("access");
  (signRefreshToken as jest.Mock).mockReturnValue("refresh");
  (getTokenExpiry as jest.Mock).mockReturnValue(new Date());
  (storeRefreshToken as jest.Mock).mockResolvedValue(undefined);
});

describe("requestPasswordReset", () => {
  it("issues a code, audits it, and emails it to an active user", async () => {
    (findUserByEmail as jest.Mock).mockResolvedValue(activeUser);

    await requestPasswordReset("  user@micd.local ", "en", "1.2.3.4");

    expect(findUserByEmail).toHaveBeenCalledWith("user@micd.local");
    expect(issueReset).toHaveBeenCalledWith(7);
    expect(sendPasswordReset).toHaveBeenCalledWith("user@micd.local", "the-code", "en");
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PASSWORD_RESET_REQUESTED", userId: 7 }),
    );
  });

  it.each([
    ["unknown", null],
    ["invited (no password)", { ...activeUser, status: "invited", password: null }],
    ["blocked", { ...activeUser, status: "blocked" }],
    ["deleted", { ...activeUser, status: "deleted" }],
  ])("does nothing for a %s account", async (_label, user) => {
    (findUserByEmail as jest.Mock).mockResolvedValue(user);

    await expect(requestPasswordReset("x@micd.local", "es", "ip")).resolves.toBeUndefined();

    expect(issueReset).not.toHaveBeenCalled();
    expect(sendPasswordReset).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("sends nothing while the per-account cooldown is running", async () => {
    (findUserByEmail as jest.Mock).mockResolvedValue(activeUser);
    (issueReset as jest.Mock).mockResolvedValue(null);

    await requestPasswordReset("user@micd.local", "es", "ip");

    expect(sendPasswordReset).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe("getResetEmail", () => {
  it("returns the email for a valid code", async () => {
    (findValidReset as jest.Mock).mockResolvedValue({ userId: 7, email: "user@micd.local" });
    expect(await getResetEmail("code")).toEqual({ email: "user@micd.local" });
  });

  it("404s for an invalid/expired/consumed code", async () => {
    (findValidReset as jest.Mock).mockResolvedValue(null);
    await expect(getResetEmail("code")).rejects.toMatchObject({ status: 404 });
  });
});

describe("resetPassword", () => {
  it("rejects a weak password before consuming the code", async () => {
    (validatePasswordStrength as jest.Mock).mockImplementation(() => {
      throw new HttpError(400, { error: "too short" });
    });
    await expect(resetPassword("code", "x", "ip")).rejects.toMatchObject({ status: 400 });
    expect(consumeReset).not.toHaveBeenCalled();
  });

  it("400s when the code cannot be consumed", async () => {
    (consumeReset as jest.Mock).mockResolvedValue(null);
    await expect(resetPassword("code", "longenough", "ip")).rejects.toMatchObject({
      status: 400,
    });
    expect(setPassword).not.toHaveBeenCalled();
  });

  it("400s when the account was blocked after the code was issued", async () => {
    (consumeReset as jest.Mock).mockResolvedValue(7);
    (findUserById as jest.Mock).mockResolvedValue({ ...activeUser, status: "blocked" });
    await expect(resetPassword("code", "longenough", "ip")).rejects.toMatchObject({
      status: 400,
    });
    expect(setPassword).not.toHaveBeenCalled();
  });

  it("sets the password, ends other sessions, audits, and returns a session", async () => {
    (consumeReset as jest.Mock).mockResolvedValue(7);
    (findUserById as jest.Mock).mockResolvedValue(activeUser);

    const result = await resetPassword("code", "longenough", "1.2.3.4");

    expect(setPassword).toHaveBeenCalledWith(7, "new-hash");
    expect(revokeAllRefreshTokensForUser).toHaveBeenCalledWith(7);
    expect(consumeAllResetsForUser).toHaveBeenCalledWith(7);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PASSWORD_RESET_COMPLETED", userId: 7 }),
    );
    expect(storeRefreshToken).toHaveBeenCalledWith(7, "refresh", expect.any(Date));
    expect(result).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      user: { id: 7, email: "user@micd.local", role: "medico" },
    });
  });
});
