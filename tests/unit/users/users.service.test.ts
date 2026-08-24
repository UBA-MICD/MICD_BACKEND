/**
 * Unit tests for the users service — validation, self-guards, duplicate/last-
 * admin/not-found mapping, and audit logging. The repository (DB/transactions)
 * and the audit sink are mocked; their real behavior is covered by
 * tests/integration/users.integration.test.ts.
 */
import { HttpError } from "../../../src/shared/http-error";
import { AUDIT_ACTIONS } from "../../../src/shared/audit";

jest.mock("../../../src/modules/users/users.repository");
jest.mock("../../../src/modules/auth/invite.service");
jest.mock("../../../src/shared/mailer");
jest.mock("../../../src/shared/audit", () => ({
  AUDIT_ACTIONS: jest.requireActual("../../../src/shared/audit").AUDIT_ACTIONS,
  logAction: jest.fn().mockResolvedValue(undefined),
}));

import * as repo from "../../../src/modules/users/users.repository";
import { issueInvite } from "../../../src/modules/auth/invite.service";
import { sendInvite } from "../../../src/shared/mailer";
import { logAction } from "../../../src/shared/audit";
import * as service from "../../../src/modules/users/users.service";

const mockRepo = repo as jest.Mocked<typeof repo>;
const mockLog = logAction as jest.Mock;
const mockIssue = issueInvite as jest.Mock;
const mockSend = sendInvite as jest.Mock;

const actor = { userId: 1, ip: "10.0.0.1" };
const row = (over: Partial<repo.UserRow> = {}): repo.UserRow => ({
  id: 2,
  name: "Jane",
  email: "jane@micd.local",
  role: "medico",
  status: "invited",
  has_password: false,
  last_login_at: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIssue.mockResolvedValue("invite-code");
  mockSend.mockResolvedValue(undefined);
});

async function expectHttp(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toBeInstanceOf(HttpError);
  await expect(p).rejects.toHaveProperty("status", status);
}

describe("createUser", () => {
  it("creates an invited user and audits USER_CREATED", async () => {
    mockRepo.insertInvitedUser.mockResolvedValue(row());
    const user = await service.createUser(
      { name: " Jane ", email: "JANE@micd.local", role: "medico" },
      actor,
    );
    expect(user).toEqual(row());
    // name trimmed, email lowercased
    expect(mockRepo.insertInvitedUser).toHaveBeenCalledWith(
      "Jane",
      "jane@micd.local",
      "medico",
    );
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.USER_CREATED }),
    );
    // issues + emails an invite and audits INVITE_SENT
    expect(mockIssue).toHaveBeenCalledWith(row().id);
    expect(mockSend).toHaveBeenCalledWith(row().email, "invite-code");
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.INVITE_SENT }),
    );
  });

  it("still creates the user when invite delivery fails", async () => {
    mockRepo.insertInvitedUser.mockResolvedValue(row());
    mockSend.mockRejectedValue(new Error("smtp down"));
    const user = await service.createUser(
      { name: "Jane", email: "jane@micd.local", role: "medico" },
      actor,
    );
    expect(user).toEqual(row()); // creation succeeds despite mail failure
  });

  it.each([
    ["missing name", { email: "a@b.co", role: "medico" }],
    ["bad email", { name: "X", email: "nope", role: "medico" }],
    ["invalid role", { name: "X", email: "a@b.co", role: "root" }],
  ])("rejects %s with 400", async (_l, input) => {
    await expectHttp(service.createUser(input as any, actor), 400);
    expect(mockRepo.insertInvitedUser).not.toHaveBeenCalled();
  });

  it("maps a duplicate email to 409", async () => {
    mockRepo.insertInvitedUser.mockResolvedValue(null);
    await expectHttp(
      service.createUser({ name: "X", email: "a@b.co", role: "admin" }, actor),
      409,
    );
    expect(mockLog).not.toHaveBeenCalled();
  });
});

describe("changeRole", () => {
  it("rejects an invalid role (400)", async () => {
    await expectHttp(service.changeRole(2, "root", actor), 400);
  });

  it("refuses to demote your own account (409)", async () => {
    await expectHttp(service.changeRole(actor.userId, "medico", actor), 409);
    expect(mockRepo.updateRole).not.toHaveBeenCalled();
  });

  it("allows setting your own role to admin (no-op demotion)", async () => {
    mockRepo.updateRole.mockResolvedValue({ ok: true, user: row({ role: "admin" }) });
    await service.changeRole(actor.userId, "admin", actor);
    expect(mockRepo.updateRole).toHaveBeenCalledWith(actor.userId, "admin");
  });

  it("maps not_found to 404 and last_admin to 409", async () => {
    mockRepo.updateRole.mockResolvedValue({ ok: false, reason: "not_found" });
    await expectHttp(service.changeRole(2, "medico", actor), 404);
    mockRepo.updateRole.mockResolvedValue({ ok: false, reason: "last_admin" });
    await expectHttp(service.changeRole(2, "medico", actor), 409);
  });

  it("audits USER_ROLE_CHANGED on success", async () => {
    mockRepo.updateRole.mockResolvedValue({ ok: true, user: row({ role: "admin" }) });
    await service.changeRole(2, "admin", actor);
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.USER_ROLE_CHANGED }),
    );
  });
});

describe("changeStatus", () => {
  it("rejects a status other than blocked/active (400)", async () => {
    await expectHttp(service.changeStatus(2, "deleted", actor), 400);
  });

  it("refuses to block your own account (409)", async () => {
    await expectHttp(service.changeStatus(actor.userId, "blocked", actor), 409);
  });

  it("audits USER_BLOCKED / USER_UNBLOCKED", async () => {
    mockRepo.updateStatus.mockResolvedValue({ ok: true, user: row({ status: "blocked" }) });
    await service.changeStatus(2, "blocked", actor);
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.USER_BLOCKED }),
    );

    mockLog.mockClear();
    mockRepo.updateStatus.mockResolvedValue({ ok: true, user: row({ status: "active" }) });
    await service.changeStatus(2, "active", actor);
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.USER_UNBLOCKED }),
    );
  });

  it("maps last_admin to 409", async () => {
    mockRepo.updateStatus.mockResolvedValue({ ok: false, reason: "last_admin" });
    await expectHttp(service.changeStatus(2, "blocked", actor), 409);
  });
});

describe("deleteUser", () => {
  it("refuses to delete your own account (409)", async () => {
    await expectHttp(service.deleteUser(actor.userId, actor), 409);
    expect(mockRepo.softDeleteUser).not.toHaveBeenCalled();
  });

  it("maps not_found to 404 and last_admin to 409", async () => {
    mockRepo.softDeleteUser.mockResolvedValue({ ok: false, reason: "not_found" });
    await expectHttp(service.deleteUser(2, actor), 404);
    mockRepo.softDeleteUser.mockResolvedValue({ ok: false, reason: "last_admin" });
    await expectHttp(service.deleteUser(2, actor), 409);
  });

  it("audits USER_DELETED on success", async () => {
    mockRepo.softDeleteUser.mockResolvedValue({ ok: true, user: row({ status: "deleted" }) });
    await service.deleteUser(2, actor);
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.USER_DELETED }),
    );
  });
});

describe("reinvite", () => {
  it("404s when the user does not exist or is deleted", async () => {
    mockRepo.findUserRow.mockResolvedValue(null);
    await expectHttp(service.reinvite(2, actor), 404);
    mockRepo.findUserRow.mockResolvedValue(row({ status: "deleted" }));
    await expectHttp(service.reinvite(2, actor), 404);
  });

  it("409s when the user is not in the invited state", async () => {
    mockRepo.findUserRow.mockResolvedValue(row({ status: "active" }));
    await expectHttp(service.reinvite(2, actor), 409);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("re-issues and resends for an invited user", async () => {
    mockRepo.findUserRow.mockResolvedValue(row({ status: "invited" }));
    await service.reinvite(2, actor);
    expect(mockIssue).toHaveBeenCalledWith(2);
    expect(mockSend).toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.INVITE_SENT }),
    );
  });
});
