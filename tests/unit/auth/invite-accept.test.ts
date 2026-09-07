/**
 * Unit tests for auth.service.getInviteEmail / acceptInvite (PR3). Collaborators
 * (invite store, user store, password, jwt, refresh tokens, audit) are mocked so
 * this is a pure unit test; the real DB path is covered by the integration suite.
 */
import { HttpError } from "../../../src/shared/http-error";

jest.mock("../../../src/modules/auth/invite.service");
jest.mock("../../../src/modules/auth/password.service");
jest.mock("../../../src/modules/auth/user.service");
jest.mock("../../../src/modules/auth/jwt.service");
jest.mock("../../../src/modules/auth/refresh-token.service");
jest.mock("../../../src/shared/audit", () => ({
  AUDIT_ACTIONS: jest.requireActual("../../../src/shared/audit").AUDIT_ACTIONS,
  logAction: jest.fn().mockResolvedValue(undefined),
}));

import {
  consumeInvite,
  findValidInvite,
} from "../../../src/modules/auth/invite.service";
import {
  validatePasswordStrength,
  hashPassword,
} from "../../../src/modules/auth/password.service";
import {
  findUserById,
  setPasswordAndActivate,
  stampLastLogin,
} from "../../../src/modules/auth/user.service";
import {
  signAccessToken,
  signRefreshToken,
  getTokenExpiry,
} from "../../../src/modules/auth/jwt.service";
import { storeRefreshToken } from "../../../src/modules/auth/refresh-token.service";
import { logAction } from "../../../src/shared/audit";
import { getInviteEmail, acceptInvite } from "../../../src/modules/auth/auth.service";

beforeEach(() => {
  jest.clearAllMocks();
  (validatePasswordStrength as jest.Mock).mockImplementation(() => undefined);
  (hashPassword as jest.Mock).mockResolvedValue("hashed");
  (setPasswordAndActivate as jest.Mock).mockResolvedValue(undefined);
  (stampLastLogin as jest.Mock).mockResolvedValue(undefined);
  (signAccessToken as jest.Mock).mockReturnValue("access");
  (signRefreshToken as jest.Mock).mockReturnValue("refresh");
  (getTokenExpiry as jest.Mock).mockReturnValue(new Date());
  (storeRefreshToken as jest.Mock).mockResolvedValue(undefined);
});

describe("getInviteEmail", () => {
  it("returns the email for a valid code", async () => {
    (findValidInvite as jest.Mock).mockResolvedValue({ userId: 5, email: "a@b.co" });
    expect(await getInviteEmail("code")).toEqual({ email: "a@b.co" });
  });

  it("404s for an invalid/expired/consumed code", async () => {
    (findValidInvite as jest.Mock).mockResolvedValue(null);
    await expect(getInviteEmail("code")).rejects.toMatchObject({ status: 404 });
  });
});

describe("acceptInvite", () => {
  it("rejects a weak password before consuming the code", async () => {
    (validatePasswordStrength as jest.Mock).mockImplementation(() => {
      throw new HttpError(400, { error: "too short" });
    });
    await expect(acceptInvite("code", "x", "ip")).rejects.toMatchObject({
      status: 400,
    });
    expect(consumeInvite).not.toHaveBeenCalled();
  });

  it("400s when the code cannot be consumed", async () => {
    (consumeInvite as jest.Mock).mockResolvedValue(null);
    await expect(acceptInvite("code", "longenough", "ip")).rejects.toMatchObject({
      status: 400,
    });
    expect(setPasswordAndActivate).not.toHaveBeenCalled();
  });

  it("activates the user, mints tokens, and audits INVITE_REDEEMED", async () => {
    (consumeInvite as jest.Mock).mockResolvedValue(9);
    (findUserById as jest.Mock).mockResolvedValue({
      id: 9,
      email: "new@micd.local",
      role: "medico",
      status: "active",
      password: "hashed",
    });

    const result = await acceptInvite("code", "longenough", "1.2.3.4");

    expect(setPasswordAndActivate).toHaveBeenCalledWith(9, "hashed");
    expect(stampLastLogin).toHaveBeenCalledWith(9);
    expect(result.user).toEqual({ id: 9, email: "new@micd.local", role: "medico" });
    expect(result.accessToken).toBe("access");
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INVITE_REDEEMED" }),
    );
  });
});
