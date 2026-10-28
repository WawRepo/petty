import { config } from "../config.js";
import { mailsLimited } from "./metrics.js";
import { checkRate } from "./password.js";

const DAY_MS = 24 * 60 * 60_000;

/**
 * PETTY-407 (security review #9): an invitation or an ownership offer emails another person, with the
 * sender's name in it. Without a limit, a sender looping invite → revoke (or many accounts aimed at one
 * person) turns Petty into a mail cannon. Each email counts against three windows of 24 hours: one per
 * drawer and recipient, SHARING_MAIL_PER_RECIPIENT per recipient, SHARING_MAIL_PER_SENDER per sender.
 * Past any of them the email is skipped and nothing else changes: the other person still sees the
 * invitation or offer in the app. A skipped email does not count against the windows after it.
 */
export async function maySendSharingMail(kind: "invitation" | "transfer", senderId: string, recipientId: string, drawerId: string): Promise<boolean> {
  const ok = (await checkRate(`sharing-mail:${kind}:${drawerId}:${recipientId}`, 1, DAY_MS))
    && (config.sharingMailPerRecipient === 0 || (await checkRate(`sharing-mail-to:${recipientId}`, config.sharingMailPerRecipient, DAY_MS)))
    && (config.sharingMailPerSender === 0 || (await checkRate(`sharing-mail-from:${senderId}`, config.sharingMailPerSender, DAY_MS)));
  if (!ok) mailsLimited.inc({ kind });
  return ok;
}
