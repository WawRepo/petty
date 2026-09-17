import { apiPool } from "../db.js";

/** Hourly housekeeping, as petty_api: nothing here touches entries. */
export async function runMaintenance(): Promise<{ sessions: number; vault_history: number }> {
  const s = await apiPool.query("delete from sessions where expires_at < now()");
  const v = await apiPool.query("delete from vault_history where replaced_at < now() - interval '30 days'");
  return { sessions: s.rowCount ?? 0, vault_history: v.rowCount ?? 0 };
}
