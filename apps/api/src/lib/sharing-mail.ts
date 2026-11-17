import { config } from "../config.js";
import { mailsLimited, type SHARING_MAIL_KINDS } from "./metrics.js";
import { checkRate } from "./password.js";
import { emailRateTag } from "./email-seal.js";

const DAY_MS = 24 * 60 * 60_000;

/**
 * PETTY-407 (security review #9): an invitation or an ownership offer emails another person, with the
 * sender's name in it. Without a limit, a sender looping invite → revoke (or many accounts aimed at one
 * person) turns Petty into a mail cannon. Each email counts against three windows of 24 hours: one per
 * drawer and recipient, SHARING_MAIL_PER_RECIPIENT per recipient, SHARING_MAIL_PER_SENDER per sender.
 * Past any of them the email is skipped and nothing else changes: the other person still sees the
 * invitation or offer in the app. A skipped email does not count against the windows after it.
 *
 * PETTY-423: a join-link email (to an address with no account yet) counts too. Its recipient is
 * `joinLinkRecipient(address)` and its `scope` is the sender, so its first window is one email per sender
 * and address a day. The caller decides what a skipped join-link email means (routes/auth.ts).
 */
export async function maySendSharingMail(kind: (typeof SHARING_MAIL_KINDS)[number], senderId: string, recipientId: string, scope: string): Promise<boolean> {
  const ok = (await checkRate(`sharing-mail:${kind}:${scope}:${recipientId}`, 1, DAY_MS))
    && (config.sharingMailPerRecipient === 0 || (await checkRate(`sharing-mail-to:${recipientId}`, config.sharingMailPerRecipient, DAY_MS)))
    && (config.sharingMailPerSender === 0 || (await checkRate(`sharing-mail-from:${senderId}`, config.sharingMailPerSender, DAY_MS)));
  if (!ok) mailsLimited.inc({ kind });
  return ok;
}

/**
 * The recipient key of a join-link email: the address in lower case, apart from account ids. Rate keys are
 * stored hashed; with an email key (PETTY-359) the address in it is an HMAC too.
 */
export const joinLinkRecipient = async (address: string): Promise<string> => `address:${await emailRateTag(address.trim().toLowerCase())}`;
