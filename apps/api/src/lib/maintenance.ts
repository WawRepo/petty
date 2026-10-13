import type { FastifyBaseLogger } from "fastify";
import { bgPool, lastRequestUse } from "../db.js";

/** Housekeeping, as petty_api: nothing here touches entries. On bgPool, so it is not counted as a request using the database. */
export async function runMaintenance(): Promise<{ sessions: number; vault_history: number; device_requests: number; custody_challenges: number; rate_counters: number; password_resets: number; join_links: number; pending: boolean }> {
  const s = await bgPool.query("delete from sessions where expires_at < now()");
  const v = await bgPool.query("delete from vault_history where replaced_at < now() - interval '30 days'");
  // PETTY-274: a device login nobody finished (a picked-up one is deleted at once)
  const d = await bgPool.query("delete from device_requests where expires_at < now()");
  // PETTY-334: what several instances share instead of their memory; each row outlives its use by a window at most
  const c = await bgPool.query("delete from custody_challenges where expires_at < now()");
  const r = await bgPool.query("delete from rate_counters where reset_at < now()");
  // PETTY-341 (GDPR, storage limitation): a reset token is dead after its hour; an unused join link that
  // ended holds an email of someone who never signed up (a used link forgets its email at once, auth.ts)
  const p = await bgPool.query("delete from password_resets where expires_at < now()");
  const j = await bgPool.query("delete from join_links where used_at is null and expires_at < now()");
  // PETTY-355: rows that end within the hour are still waiting, so the next run must not wait a day
  const left = await bgPool.query<{ pending: boolean }>(
    "select exists(select 1 from rate_counters) or exists(select 1 from device_requests) or exists(select 1 from custody_challenges) or exists(select 1 from password_resets) as pending",
  );
  return { sessions: s.rowCount ?? 0, vault_history: v.rowCount ?? 0, device_requests: d.rowCount ?? 0, custody_challenges: c.rowCount ?? 0, rate_counters: r.rowCount ?? 0, password_resets: p.rowCount ?? 0, join_links: j.rowCount ?? 0, pending: left.rows[0]!.pending };
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
      .then((r) => { pending = r.pending; log.info(r, "maintenance"); })
      .catch((err: unknown) => log.warn({ err: { name: (err as Error).name } }, "maintenance failed"));
  };
  tick();
  setInterval(tick, 5 * 60_000).unref();
}
