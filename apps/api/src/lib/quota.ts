import { config } from "../config.js";
import { tooLarge } from "./errors.js";
import type { Queryable } from "./tx.js";

/**
 * PETTY-243: per-user storage. What counts is the ciphertext stored in the drawers a person OWNS —
 * photos, documents, the 30-day document history and entries — so writes by members of a shared
 * drawer count against its owner. The server cannot read any of it; it only counts bytes.
 *
 * The check is soft: two writes racing at the limit can both pass, overshooting by one record.
 * That is fine for a storage budget and keeps writes free of a per-owner lock.
 */
export async function storageUsed(db: Queryable, ownerId: string): Promise<number> {
  const { rows } = await db.query<{ used: string }>(
    `with d as (select id from drawers where owner_id = $1)
     select (coalesce((select sum(octet_length(ciphertext)) from drawer_photos where drawer_id in (select id from d)), 0)
           + coalesce((select sum(octet_length(ciphertext)) from drawer_documents where drawer_id in (select id from d)), 0)
           + coalesce((select sum(octet_length(ciphertext)) from drawer_document_history where drawer_id in (select id from d)), 0)
           + coalesce((select sum(octet_length(ciphertext)) from entries where drawer_id in (select id from d)), 0))::text as used`,
    [ownerId],
  );
  return Number(rows[0]?.used ?? 0);
}

/**
 * Refuses a write that would add `addBytes` to a drawer owner's storage past the instance quota.
 * Writes that add nothing (a smaller photo, a delete) always pass, so a full account can free space.
 */
export async function assertQuota(db: Queryable, ownerId: string, addBytes: number): Promise<void> {
  const quota = config.storageQuotaBytes;
  if (quota === null || addBytes <= 0) return;
  const used = await storageUsed(db, ownerId);
  if (used + addBytes > quota) throw tooLarge("StorageQuotaExceeded", "storage quota reached", { owner_id: ownerId, used_bytes: used, quota_bytes: quota });
}
