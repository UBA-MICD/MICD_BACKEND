import { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import * as usersService from "./users.service";
import type { Actor } from "./users.service";

/** The acting admin, from the verified token + request IP. */
function actorOf(req: Parameters<RequestHandler>[0]): Actor {
  return { userId: req.user!.sub, ip: req.ip ?? "" };
}

/** Parse a positive integer :id route param, or null. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const listUsers: RequestHandler = async (_req, res) => {
  try {
    res.json(await usersService.listUsers());
  } catch (err) {
    sendError(res, err);
  }
};

export const createUser: RequestHandler = async (req, res) => {
  try {
    const user = await usersService.createUser(req.body ?? {}, actorOf(req));
    res.status(201).json(user);
  } catch (err) {
    sendError(res, err);
  }
};

export const updateRole: RequestHandler = async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid user id" });
    return;
  }
  try {
    const user = await usersService.changeRole(id, req.body?.role, actorOf(req));
    res.json(user);
  } catch (err) {
    sendError(res, err);
  }
};

export const updateStatus: RequestHandler = async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid user id" });
    return;
  }
  try {
    const user = await usersService.changeStatus(
      id,
      req.body?.status,
      actorOf(req),
    );
    res.json(user);
  } catch (err) {
    sendError(res, err);
  }
};

export const deleteUser: RequestHandler = async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid user id" });
    return;
  }
  try {
    await usersService.deleteUser(id, actorOf(req));
    res.status(204).send();
  } catch (err) {
    sendError(res, err);
  }
};
