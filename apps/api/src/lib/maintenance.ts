import type { FastifyBaseLogger } from "fastify";
import { bgPool, lastRequestUse } from "../db.js";
import { dropExpiredTokenData } from "./tokens.js";
import { rewriteEmails, type RewriteResult } from "./email-seal.js";

/** How long a replaced drawer document stays restorable (PETTY-183, review NR-3); a replaced user document or photo too (PETTY-506). */
export const HISTORY_DAYS = 30;
/** How long a Clerk session's row stays after a request last carried it (PETTY-285, lib/clerk-sessions.ts). */
export const CLERK_SESSION_DAYS = 30;

/** Housekeeping, as petty_api: nothing here touches entries. On bgPool, so it is not counted as a request using the database. */
export async function runMaintenance(): Promise<{ sessions: number; vault_history: number; document_history: number; device_requests: number; custody_challenges: number; rate_counters: number; clerk_sessions: number; password_resets: number; join_links: number; tokens: number; tombstones: number; kept_copies: number; emails: RewriteResult; pending: boolean }> {
  const s = await bgPool.query("delete from sessions where expires_at < now()");
  const v = await bgPool.query("delete from vault_history where replaced_at < now() - interval '30 days'");
  // PETTY-488: a write drops its own drawer's old copies, but a drawer nobody writes to again kept them for good
  const h = await bgPool.query("delete from drawer_document_history where replaced_at < now() - make_interval(days => $1)", [HISTORY_DAYS]);
  // PETTY-506: kept user documents and photos, the same 30 days (a write prunes its own, lib/kept.ts)
  const ku = await bgPool.query("delete from user_doc_history where replaced_at < now() - make_interval(days => $1)", [HISTORY_DAYS]);
  const kp = await bgPool.query("delete from drawer_photo_history where replaced_at < now() - make_interval(days => $1)", [HISTORY_DAYS]);
  // PETTY-274: a device login nobody finished (a picked-up one is deleted at once)
  const d = await bgPool.query("delete from device_requests where expires_at < now()");
  // PETTY-334: what several instances share instead of their memory; each row outlives its use by a window at most
  const c = await bgPool.query("delete from custody_challenges where expires_at < now()");
  const r = await bgPool.query("delete from rate_counters where reset_at < now()");
  // PETTY-285: the Clerk sessions counted as sign-ins, once not seen for a while (lib/clerk-sessions.ts)
  const k = await bgPool.query("delete from clerk_sessions_seen where seen_at < now() - make_interval(days => $1)", [CLERK_SESSION_DAYS]);
  // PETTY-341 (GDPR, storage limitation): a reset token is dead after its hour; an unused join link that
  // ended holds an email of someone who never signed up (a used link forgets its email at once, auth.ts)
  const p = await bgPool.query("delete from password_resets where expires_at < now()");
  const j = await bgPool.query("delete from join_links where used_at is null and expires_at < now()");
  // PETTY-410: an expired (or revoked) token never works again, so its sealed bundle and drawer-key wraps go
  const t = await dropExpiredTokenData(bgPool, null);
  // PETTY-349: a deleted account's row and public keys, once no record someone else keeps needs them (the rule is in
  // migration 019). After the history clean-up above, which can be what still pointed at them.
  const g = await bgPool.query<{ n: number }>("select purge_tombstones() as n");
  // PETTY-359: addresses into the current form: sealed with EMAIL_KEY (a new key: EMAIL_KEY_OLD's rows move to it), or
  // plain when only EMAIL_KEY_OLD is set. No key at all: nothing to do. After the clean-ups, so nothing they delete is sealed first.
  const emails = await rewriteEmails(bgPool);
  // PETTY-355: rows that end within the hour are still waiting, so the next run must not wait a day
  const left = await bgPool.query<{ pending: boolean }>(
    "select exists(select 1 from rate_counters) or exists(select 1 from device_requests) or exists(select 1 from custody_challenges) or exists(select 1 from password_resets) as pending",
  );
  return { sessions: s.rowCount ?? 0, vault_history: v.rowCount ?? 0, document_history: h.rowCount ?? 0, device_requests: d.rowCount ?? 0, custody_challenges: c.rowCount ?? 0, rate_counters: r.rowCount ?? 0, clerk_sessions: k.rowCount ?? 0, password_resets: p.rowCount ?? 0, join_links: j.rowCount ?? 0, tokens: t, tombstones: g.rows[0]!.n, kept_copies: (ku.rowCount ?? 0) + (kp.rowCount ?? 0), emails, pending: left.rows[0]!.pending };
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * Whether housekeeping is due (PETTY-355): hourly while requests use the database or short-lived rows wait
 * for their end, otherwise once a day. An idle instance then wakes a scale-to-zero database once a day, not
 * 24 times, and a short-lived row still goes within an hour of its end.
 */
export function maintenanceDue(now: number, lastRun: number, pending: boolean, requestUse: number): boolean {
  const since = now - lastRun;
  return since >= DAY || (since >= HOUR && (pending || requestUse > lastRun));
}

let lastRun = 0;
/** When housekeeping last started (ms since the epoch; 0 = not since start). */
export const lastMaintenance = (): number => lastRun;

/** Runs housekeeping at start, then checks every 5 minutes whether it is due. */
export function startMaintenance(log: Pick<FastifyBaseLogger, "info" | "warn">): void {
  let pending = true;
  const tick = () => {
    if (!maintenanceDue(Date.now(), lastRun, pending, lastRequestUse())) return;
    lastRun = Date.now();
    runMaintenance()
      .then((r) => {
        pending = r.pending;
        log.info(r, "maintenance");
        // a row another instance sealed with a key this one does not have (its start-up check would refuse it now)
        if (r.emails.unknown) log.warn({ rows: r.emails.unknown }, "emails sealed with a key this instance does not have: set EMAIL_KEY");
      })
      .catch((err: unknown) => log.warn({ err: { name: (err as Error).name } }, "maintenance failed"));
  };
  tick();
  setInterval(tick, 5 * 60_000).unref();
}
