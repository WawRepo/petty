import { apiPool } from "../db.js";

/** Hourly housekeeping, as petty_api: nothing here touches entries. */
export async function runMaintenance(): Promise<{ sessions: number; vault_history: number; device_requests: number }> {
  const s = await apiPool.query("delete from sessions where expires_at < now()");
  const v = await apiPool.query("delete from vault_history where replaced_at < now() - interval '30 days'");
  // PETTY-274: a device login nobody finished (a picked-up one is deleted at once)
  const d = await apiPool.query("delete from device_requests where expires_at < now()");
  return { sessions: s.rowCount ?? 0, vault_history: v.rowCount ?? 0, device_requests: d.rowCount ?? 0 };
}
