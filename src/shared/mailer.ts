import nodemailer, { type Transporter } from "nodemailer";
import { smtpConfig, appBaseUrl } from "../config/env";

/**
 * Invite and password-reset email delivery. When SMTP is configured (SMTP_HOST set) an email is
 * sent; otherwise the invite link is logged to stdout so dev, CI and the
 * integration suite work with no mail server. Behavior is gated on
 * smtpConfig.enabled, never on NODE_ENV (the test stack runs as production).
 */

type MailLocale = "es" | "en";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!smtpConfig.enabled) return null;
  transporter ??= nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.port === 465,
    auth:
      smtpConfig.user && smtpConfig.pass
        ? { user: smtpConfig.user, pass: smtpConfig.pass }
        : undefined,
  });
  return transporter;
}

/** Build the invite link the accept-invite screen is reached by. */
export function inviteLink(code: string): string {
  return `${appBaseUrl.value}/?invite=${encodeURIComponent(code)}`;
}

function inviteTemplate(
  code: string,
  link: string,
  locale: MailLocale,
): { subject: string; text: string; html: string } {
  if (locale === "en") {
    return {
      subject: "Your MICD invitation code",
      text: `You have been invited to MICD.\n\nYour activation code is:\n\n    ${code}\n\nIn the app, open "Were you invited?" and enter your email and this code to set your password and sign in.\n\nYou can also open this link directly: ${link}\n\nThe code expires in 48 hours.`,
      html: `<p>You have been invited to <strong>MICD</strong>.</p><p>Your activation code is:</p><p style="font-size:20px;font-weight:bold;font-family:monospace;letter-spacing:1px">${code}</p><p>In the app, open <strong>"Were you invited?"</strong> and enter your email and this code to set your password and sign in.</p><p>You can also open this link directly: <a href="${link}">${link}</a></p><p>The code expires in 48 hours.</p>`,
    };
  }
  return {
    subject: "Tu código de invitación a MICD",
    text: `Te invitaron a MICD.\n\nTu código de activación es:\n\n    ${code}\n\nEn la app, abrí "¿Te invitaron?" e ingresá tu email y este código para crear tu contraseña e iniciar sesión.\n\nTambién podés abrir directamente este enlace: ${link}\n\nEl código vence en 48 horas.`,
    html: `<p>Te invitaron a <strong>MICD</strong>.</p><p>Tu código de activación es:</p><p style="font-size:20px;font-weight:bold;font-family:monospace;letter-spacing:1px">${code}</p><p>En la app, abrí <strong>"¿Te invitaron?"</strong> e ingresá tu email y este código para crear tu contraseña e iniciar sesión.</p><p>También podés abrir directamente este enlace: <a href="${link}">${link}</a></p><p>El código vence en 48 horas.</p>`,
  };
}

/**
 * Send (or log) an invite for `email`. Never throws for a missing mail server —
 * it logs the link instead, so the caller's user-creation flow is unaffected.
 */
export async function sendInvite(
  email: string,
  code: string,
  locale: MailLocale = "es",
): Promise<void> {
  const link = inviteLink(code);
  const tx = getTransporter();
  if (!tx) {
    console.log(
      `[mailer] SMTP not configured — invite code for ${email}: ${code} (link: ${link})`,
    );
    return;
  }
  const { subject, text, html } = inviteTemplate(code, link, locale);
  await tx.sendMail({ from: smtpConfig.from, to: email, subject, text, html });
}

/** Build the link the reset-password screen is reached by. */
export function resetLink(code: string): string {
  return `${appBaseUrl.value}/?reset=${encodeURIComponent(code)}`;
}

function resetTemplate(
  code: string,
  link: string,
  locale: MailLocale,
): { subject: string; text: string; html: string } {
  if (locale === "en") {
    return {
      subject: "Reset your MICD password",
      text: `Someone asked to reset the password of your MICD account.\n\nYour reset code is:\n\n    ${code}\n\nIn the app, open "Forgot your password?" and enter this code to choose a new password.\n\nYou can also open this link directly: ${link}\n\nThe code expires in 1 hour. If you didn't ask for this, ignore this email — your password won't change.`,
      html: `<p>Someone asked to reset the password of your <strong>MICD</strong> account.</p><p>Your reset code is:</p><p style="font-size:20px;font-weight:bold;font-family:monospace;letter-spacing:1px">${code}</p><p>In the app, open <strong>"Forgot your password?"</strong> and enter this code to choose a new password.</p><p>You can also open this link directly: <a href="${link}">${link}</a></p><p>The code expires in 1 hour. If you didn't ask for this, ignore this email — your password won't change.</p>`,
    };
  }
  return {
    subject: "Restablecé tu contraseña de MICD",
    text: `Alguien pidió restablecer la contraseña de tu cuenta de MICD.\n\nTu código de recuperación es:\n\n    ${code}\n\nEn la app, abrí "¿Olvidaste tu contraseña?" e ingresá este código para elegir una contraseña nueva.\n\nTambién podés abrir directamente este enlace: ${link}\n\nEl código vence en 1 hora. Si no lo pediste, ignorá este correo: tu contraseña no va a cambiar.`,
    html: `<p>Alguien pidió restablecer la contraseña de tu cuenta de <strong>MICD</strong>.</p><p>Tu código de recuperación es:</p><p style="font-size:20px;font-weight:bold;font-family:monospace;letter-spacing:1px">${code}</p><p>En la app, abrí <strong>"¿Olvidaste tu contraseña?"</strong> e ingresá este código para elegir una contraseña nueva.</p><p>También podés abrir directamente este enlace: <a href="${link}">${link}</a></p><p>El código vence en 1 hora. Si no lo pediste, ignorá este correo: tu contraseña no va a cambiar.</p>`,
  };
}

/** Send (or, with SMTP unset, log) a password-reset code for `email`. */
export async function sendPasswordReset(
  email: string,
  code: string,
  locale: MailLocale = "es",
): Promise<void> {
  const link = resetLink(code);
  const tx = getTransporter();
  if (!tx) {
    console.log(
      `[mailer] SMTP not configured — password reset code for ${email}: ${code} (link: ${link})`,
    );
    return;
  }
  const { subject, text, html } = resetTemplate(code, link, locale);
  await tx.sendMail({ from: smtpConfig.from, to: email, subject, text, html });
}
