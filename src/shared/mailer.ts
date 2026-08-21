import nodemailer, { type Transporter } from "nodemailer";
import { smtpConfig, appBaseUrl } from "../config/env";

/**
 * Invite email delivery. When SMTP is configured (SMTP_HOST set) an email is
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
  link: string,
  locale: MailLocale,
): { subject: string; text: string; html: string } {
  if (locale === "en") {
    return {
      subject: "You've been invited to MICD",
      text: `You have been invited to MICD. Open this link to set your password and sign in:\n\n${link}\n\nThe link expires in 48 hours.`,
      html: `<p>You have been invited to <strong>MICD</strong>.</p><p>Open this link to set your password and sign in:</p><p><a href="${link}">${link}</a></p><p>The link expires in 48 hours.</p>`,
    };
  }
  return {
    subject: "Te invitaron a MICD",
    text: `Te invitaron a MICD. Abrí este enlace para crear tu contraseña e iniciar sesión:\n\n${link}\n\nEl enlace vence en 48 horas.`,
    html: `<p>Te invitaron a <strong>MICD</strong>.</p><p>Abrí este enlace para crear tu contraseña e iniciar sesión:</p><p><a href="${link}">${link}</a></p><p>El enlace vence en 48 horas.</p>`,
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
    console.log(`[mailer] SMTP not configured — invite link for ${email}: ${link}`);
    return;
  }
  const { subject, text, html } = inviteTemplate(link, locale);
  await tx.sendMail({ from: smtpConfig.from, to: email, subject, text, html });
}
