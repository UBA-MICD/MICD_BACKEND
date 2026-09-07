import { HttpError } from "../../shared/http-error";
import { isRole, Role } from "../../shared/roles";
import { AUDIT_ACTIONS, logAction } from "../../shared/audit";
import { issueInvite } from "../auth/invite.service";
import { sendInvite } from "../../shared/mailer";
import * as repo from "./users.repository";
import type { MutationResult, UserRow } from "./users.repository";

/** Who is performing the action, for self-guards and the audit trail. */
export interface Actor {
  userId: number;
  ip: string;
}

/** Map a guarded-mutation failure to the right HttpError. */
function mapFailure(result: Extract<MutationResult, { ok: false }>): never {
  if (result.reason === "not_found") {
    throw new HttpError(404, { error: "User not found" });
  }
  throw new HttpError(409, {
    error: "Cannot remove the last admin",
    detail: "Promote another user to admin first.",
  });
}

export function listUsers(): Promise<UserRow[]> {
  return repo.listUsers();
}

export async function createUser(
  input: { name?: unknown; email?: unknown; role?: unknown },
  actor: Actor,
): Promise<UserRow> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const { role } = input;

  if (!name) throw new HttpError(400, { error: "name is required" });
  if (!email || !email.includes("@")) {
    throw new HttpError(400, { error: "a valid email is required" });
  }
  if (!isRole(role)) throw new HttpError(400, { error: "Invalid role" });

  const user = await repo.insertInvitedUser(name, email, role);
  if (!user) throw new HttpError(409, { error: "Email already in use" });

  await logAction({
    userId: actor.userId,
    action: AUDIT_ACTIONS.USER_CREATED,
    resourceId: String(user.id),
    ip: actor.ip,
    detail: { email, role },
  });
  await sendUserInvite(user, actor);
  return user;
}

/**
 * Issue an invite and email it, then audit INVITE_SENT. A mail-delivery failure
 * is logged but does not fail the surrounding operation — the admin can re-send
 * from the panel (POST /:id/invite).
 */
async function sendUserInvite(user: UserRow, actor: Actor): Promise<void> {
  try {
    const code = await issueInvite(user.id);
    await sendInvite(user.email, code);
    await logAction({
      userId: actor.userId,
      action: AUDIT_ACTIONS.INVITE_SENT,
      resourceId: String(user.id),
      ip: actor.ip,
    });
  } catch (err) {
    console.error(`Failed to send invite to user ${user.id}:`, err);
  }
}

/** Re-issue and resend an invite for a still-invited user. */
export async function reinvite(id: number, actor: Actor): Promise<UserRow> {
  const user = await repo.findUserRow(id);
  if (!user || user.status === "deleted") {
    throw new HttpError(404, { error: "User not found" });
  }
  if (user.status !== "invited") {
    throw new HttpError(409, {
      error: "Only invited users can be re-invited",
    });
  }
  await sendUserInvite(user, actor);
  return user;
}

export async function changeRole(
  id: number,
  role: unknown,
  actor: Actor,
): Promise<UserRow> {
  if (!isRole(role)) throw new HttpError(400, { error: "Invalid role" });
  if (id === actor.userId && role !== "admin") {
    throw new HttpError(409, { error: "You cannot demote your own account" });
  }

  const result = await repo.updateRole(id, role);
  if (!result.ok) mapFailure(result);

  await logAction({
    userId: actor.userId,
    action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
    resourceId: String(id),
    ip: actor.ip,
    detail: { role: result.user.role },
  });
  return result.user;
}

export async function changeStatus(
  id: number,
  status: unknown,
  actor: Actor,
): Promise<UserRow> {
  if (status !== "blocked" && status !== "active") {
    throw new HttpError(400, {
      error: "status must be 'blocked' or 'active'",
    });
  }
  if (id === actor.userId && status === "blocked") {
    throw new HttpError(409, { error: "You cannot block your own account" });
  }

  const result = await repo.updateStatus(id, status);
  if (!result.ok) mapFailure(result);

  await logAction({
    userId: actor.userId,
    action:
      status === "blocked"
        ? AUDIT_ACTIONS.USER_BLOCKED
        : AUDIT_ACTIONS.USER_UNBLOCKED,
    resourceId: String(id),
    ip: actor.ip,
  });
  return result.user;
}

export async function deleteUser(id: number, actor: Actor): Promise<void> {
  if (id === actor.userId) {
    throw new HttpError(409, { error: "You cannot delete your own account" });
  }

  const result = await repo.softDeleteUser(id);
  if (!result.ok) mapFailure(result);

  await logAction({
    userId: actor.userId,
    action: AUDIT_ACTIONS.USER_DELETED,
    resourceId: String(id),
    ip: actor.ip,
  });
}
