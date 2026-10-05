import { RequestHandler } from "express";
import { sendError } from "../../shared/http-error";
import * as authService from "./auth.service";

export const loginHandler: RequestHandler = async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  try {
    const result = await authService.login(email, password);
    res.status(200).json(result);
  } catch (err) {
    sendError(res, err);
  }
};

export const refreshHandler: RequestHandler = async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== "string") {
    res.status(400).json({ error: "refreshToken is required" });
    return;
  }

  try {
    const tokens = await authService.refresh(refreshToken);
    res.status(200).json(tokens);
  } catch (err) {
    sendError(res, err);
  }
};

export const logoutHandler: RequestHandler = async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken === "string") {
    await authService.logout(refreshToken);
  }
  res.status(204).send();
};

export const getInviteHandler: RequestHandler = async (req, res) => {
  try {
    res.status(200).json(await authService.getInviteEmail(req.params.code));
  } catch (err) {
    sendError(res, err);
  }
};

export const acceptInviteHandler: RequestHandler = async (req, res) => {
  const { code, password } = req.body ?? {};
  if (typeof code !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "code and password are required" });
    return;
  }

  try {
    const result = await authService.acceptInvite(code, password, req.ip ?? "");
    res.status(200).json(result);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * Always 202, whatever the email — the lookup, code issue and email send run
 * after the response is flushed, so neither the status nor the response time
 * reveals whether the account exists.
 */
export const forgotPasswordHandler: RequestHandler = (req, res) => {
  const { email, locale } = req.body ?? {};
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  res.status(202).json({ ok: true });

  authService
    .requestPasswordReset(email, locale === "en" ? "en" : "es", req.ip ?? "")
    .catch((err) => {
      console.error("[auth] password reset request failed:", err);
    });
};

export const getResetHandler: RequestHandler = async (req, res) => {
  try {
    res.status(200).json(await authService.getResetEmail(req.params.code));
  } catch (err) {
    sendError(res, err);
  }
};

export const resetPasswordHandler: RequestHandler = async (req, res) => {
  const { code, password } = req.body ?? {};
  if (typeof code !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "code and password are required" });
    return;
  }

  try {
    const result = await authService.resetPassword(code, password, req.ip ?? "");
    res.status(200).json(result);
  } catch (err) {
    sendError(res, err);
  }
};
