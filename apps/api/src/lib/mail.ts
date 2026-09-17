import nodemailer from "nodemailer";
import { config } from "../config.js";
import { mailsSent } from "./metrics.js";

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

export const mails = {
  joinLink: (to: string, inviter: string, token: string) => sendMail(to, "You are invited to Petty", `${inviter} invited you to Petty, a shared cash ledger.\n\nCreate your account here (the link works once, for 7 days):\n${config.appUrl}/join#${token}\n`),
  invitation: (to: string, inviter: string, role: string) => sendMail(to, "A drawer was shared with you", `${inviter} invited you to a drawer in Petty as ${role === "write" ? "a writer" : "a reader"}.\n\nOpen Petty to accept or decline: ${config.appUrl}/\n`),
  revoked: (to: string, owner: string) => sendMail(to, "Your access to a drawer ended", `${owner} removed you from a shared drawer in Petty. You keep nothing that was shared after this moment.\n`),
  transferOffered: (to: string, owner: string) => sendMail(to, "You were offered a drawer", `${owner} wants to hand a drawer over to you in Petty. Open Petty to accept: ${config.appUrl}/\n`),
  transferDone: (to: string, newOwner: string) => sendMail(to, "Ownership transferred", `${newOwner} accepted your drawer in Petty and now owns it. You stay a writer.\n`),
  passwordReset: (to: string, token: string, locale: string) => locale === "pl"
    ? sendMail(to, "Reset hasła logowania w Petty", `Ktoś (mamy nadzieję, że Ty) poprosił o reset hasła logowania w Petty.\n\nUstaw nowe hasło tutaj (link działa raz, przez godzinę):\n${config.appUrl}/reset#${token}\n\nTo zmienia tylko hasło logowania. Hasło sejfu i kod odzyskiwania pozostają bez zmian — nikt nie może ich zresetować.\nJeśli to nie Ty, zignoruj tę wiadomość.\n`)
    : sendMail(to, "Reset your Petty login password", `Someone (we hope you) asked to reset the login password for Petty.\n\nSet a new one here (the link works once, for one hour):\n${config.appUrl}/reset#${token}\n\nThis changes the login password only. Your vault passphrase and recovery code stay as they are — nobody can reset those.\nIf this was not you, ignore this message.\n`),
  passwordChanged: (to: string, locale: string) => locale === "pl"
    ? sendMail(to, "Hasło logowania do Petty zostało zmienione", `Hasło logowania do Twojego konta Petty właśnie zostało zmienione przez link resetujący.\n\nJeśli to Ty — wszystko w porządku. Jeśli nie, zaloguj się i zmień hasło, albo napisz do nas.\nHasło sejfu i kod odzyskiwania pozostają bez zmian.\n`)
    : sendMail(to, "Your Petty login password was changed", `The login password for your Petty account was just changed through a reset link.\n\nIf that was you, all is well. If not, sign in and change it, or write to us.\nYour vault passphrase and recovery code are unchanged.\n`),
  vaultReplaced: (to: string, locale: string) => locale === "pl"
    ? sendMail(to, "Hasło sejfu w Petty zostało zmienione", `Hasło sejfu (lub kod odzyskiwania) Twojego konta Petty zostało właśnie zmienione z odblokowanego urządzenia.\n\nJeśli to nie Ty, napisz do nas: poprzednią wersję można przywrócić przez 30 dni.\n`)
    : sendMail(to, "Your Petty vault passphrase was changed", `The vault passphrase (or recovery code) of your Petty account was just changed from an unlocked device.\n\nIf that was not you, write to us: the previous version can be restored for 30 days.\n`),
  handedOver: (to: string, from: string) => sendMail(to, "A drawer is now yours", `${from} deleted their Petty account and handed one of their drawers to you. You are its owner now.\n`),
};
