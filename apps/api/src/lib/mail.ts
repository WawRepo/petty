import nodemailer from "nodemailer";
import { config } from "../config.js";
import { mailsSent } from "./metrics.js";
import { MAIL, mailLocale, type MailText } from "./mail-text.js";

// Security review SR-10: the local dev relay (mailpit) has no TLS; every other host must STARTTLS,
// because the mails carry reset and join tokens.
const local = config.smtpHost === "localhost" || config.smtpHost === "127.0.0.1" || config.smtpHost === "mailpit";
const transport = nodemailer.createTransport({
  host: config.smtpHost, port: config.smtpPort, secure: config.smtpPort === 465,
  ...(local ? { ignoreTLS: true } : { requireTLS: true }),
  ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPass } } : {}),
});

/**
 * Plain-text notification emails (spec "Notification": in-app AND by email).
 * Fire-and-forget: a mail failure never fails the request. Bodies carry names
 * and links only — never drawer content.
 */
/** Last few mails, for tests and local debugging. Names and links only — never content. */
export const sentMails: Array<{ to: string; subject: string; text: string }> = [];
export function sendMail(to: string, subject: string, text: string): void {
  sentMails.push({ to, subject, text });
  if (sentMails.length > 50) sentMails.shift();
  transport.sendMail({ from: config.mailFrom, to, subject, text }).then(() => mailsSent.inc({ result: "ok" })).catch((err: unknown) => {
    mailsSent.inc({ result: "failed" });
    console.error("mail failed", { class: err instanceof Error ? err.name : "Error", to_domain: to.split("@")[1] ?? null });
  });
}

/** Each mail in the recipient's language (lib/mail-text.ts; unknown or missing locale → English). */
const send = (to: string, m: MailText) => sendMail(to, m.subject, m.text);
export const mails = {
  joinLink: (to: string, inviter: string, token: string, locale: string) => send(to, MAIL[mailLocale(locale)].joinLink(inviter, `${config.appUrl}/join#${token}`)),
  invitation: (to: string, inviter: string, role: string, locale: string) => send(to, MAIL[mailLocale(locale)].invitation(inviter, role === "write" ? "write" : "read", config.appUrl)),
  relinked: (to: string, locale: string) => send(to, MAIL[mailLocale(locale)].relinked(config.appUrl, config.contactEmail)),
  revoked: (to: string, owner: string, locale: string) => send(to, MAIL[mailLocale(locale)].revoked(owner)),
  transferOffered: (to: string, owner: string, locale: string) => send(to, MAIL[mailLocale(locale)].transferOffered(owner, config.appUrl)),
  transferDone: (to: string, newOwner: string, locale: string) => send(to, MAIL[mailLocale(locale)].transferDone(newOwner)),
  passwordReset: (to: string, token: string, locale: string) => send(to, MAIL[mailLocale(locale)].passwordReset(`${config.appUrl}/reset#${token}`)),
  passwordChanged: (to: string, locale: string) => send(to, MAIL[mailLocale(locale)].passwordChanged(config.contactEmail)),
  vaultReplaced: (to: string, locale: string) => send(to, MAIL[mailLocale(locale)].vaultReplaced(config.contactEmail)),
  handedOver: (to: string, from: string, locale: string) => send(to, MAIL[mailLocale(locale)].handedOver(from)),
};
