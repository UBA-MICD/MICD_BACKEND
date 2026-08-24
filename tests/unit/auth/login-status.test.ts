/**
 * Unit tests for the account-status handling added to auth.service.login (2.2):
 * a blocked or deleted account is refused with the SAME generic 401 as bad
 * credentials, an active account stamps last_login_at, and neither path leaks
 * which check failed. Collaborators are mocked so this stays a pure unit test.
 */
import { HttpError } from "../../../src/shared/http-error";

jest.mock("../../../src/modules/auth/password.service");
jest.mock("../../../src/modules/auth/user.service");
jest.mock("../../../src/modules/auth/jwt.service");
jest.mock("../../../src/modules/auth/refresh-token.service");

import { verifyPassword } from "../../../src/modules/auth/password.service";
import {
  findUserByEmail,
  stampLastLogin,
} from "../../../src/modules/auth/user.service";
import {
  signAccessToken,
  signRefreshToken,
  getTokenExpiry,
} from "../../../src/modules/auth/jwt.service";
import { storeRefreshToken } from "../../../src/modules/auth/refresh-token.service";
import { login } from "../../../src/modules/auth/auth.service";

const mUser = { id: 7, email: "u@micd.local", password: "$2b$hash", role: "medico" as const };

beforeEach(() => {
  jest.clearAllMocks();
  (verifyPassword as jest.Mock).mockResolvedValue(true);
  (signAccessToken as jest.Mock).mockReturnValue("access");
  (signRefreshToken as jest.Mock).mockReturnValue("refresh");
  (getTokenExpiry as jest.Mock).mockReturnValue(new Date());
  (storeRefreshToken as jest.Mock).mockResolvedValue(undefined);
  (stampLastLogin as jest.Mock).mockResolvedValue(undefined);
});

describe("login account-status handling", () => {
  it("logs in an active user and stamps last_login_at", async () => {
    (findUserByEmail as jest.Mock).mockResolvedValue({ ...mUser, status: "active" });
    const result = await login("u@micd.local", "pw");
    expect(result.user).toEqual({ id: 7, email: "u@micd.local", role: "medico" });
    expect(stampLastLogin).toHaveBeenCalledWith(7);
    expect(storeRefreshToken).toHaveBeenCalled();
  });

  it.each(["blocked", "deleted"])(
    "refuses a %s account with a generic 401 and does not stamp or sign",
    async (status) => {
      (findUserByEmail as jest.Mock).mockResolvedValue({ ...mUser, status });
      await expect(login("u@micd.local", "pw")).rejects.toMatchObject({
        status: 401,
        body: { error: "Invalid email or password" },
      });
      expect(stampLastLogin).not.toHaveBeenCalled();
      expect(storeRefreshToken).not.toHaveBeenCalled();
    },
  );

  it("still 401s on a wrong password before the status check", async () => {
    (findUserByEmail as jest.Mock).mockResolvedValue({ ...mUser, status: "active" });
    (verifyPassword as jest.Mock).mockResolvedValue(false);
    await expect(login("u@micd.local", "pw")).rejects.toBeInstanceOf(HttpError);
    expect(stampLastLogin).not.toHaveBeenCalled();
  });
});
