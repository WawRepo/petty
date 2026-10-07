import { apiPool } from "../db.js";

/** Hourly housekeeping, as petty_api: nothing here touches entries. */
export async function runMaintenance(): Promise<{ sessions: number; vault_history: number; device_requests: number; custody_challenges: number; rate_counters: number; password_resets: number; join_links: number }> {
  const s = await apiPool.query("delete from sessions where expires_at < now()");
  const v = await apiPool.query("delete from vault_history where replaced_at < now() - interval '30 days'");
  // PETTY-274: a device login nobody finished (a picked-up one is deleted at once)
  const d = await apiPool.query("delete from device_requests where expires_at < now()");
  // PETTY-334: what several instances share instead of their memory; each row outlives its use by a window at most
  const c = await apiPool.query("delete from custody_challenges where expires_at < now()");
  const r = await apiPool.query("delete from rate_counters where reset_at < now()");
  // PETTY-341 (GDPR, storage limitation): a reset token is dead after its hour; an unused join link that
  // ended holds an email of someone who never signed up (a used link forgets its email at once, auth.ts)
  const p = await apiPool.query("delete from password_resets where expires_at < now()");
  const j = await apiPool.query("delete from join_links where used_at is null and expires_at < now()");
  return { sessions: s.rowCount ?? 0, vault_history: v.rowCount ?? 0, device_requests: d.rowCount ?? 0, custody_challenges: c.rowCount ?? 0, rate_counters: r.rowCount ?? 0, password_resets: p.rowCount ?? 0, join_links: j.rowCount ?? 0 };
}
