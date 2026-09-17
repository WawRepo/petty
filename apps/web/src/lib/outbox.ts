/**
 * The offline outbox (spec "Offline behavior"): what would have gone over the
 * wire, kept in IndexedDB until it can. Entries are already sealed; document
 * operations are sealed under the drawer key before they are stored. Nothing in
 * here is readable without the vault.
 */
import { idb } from "./idb.js";

export interface OutboxEntry {
  readonly id: string;              // = the entry id (client-assigned, idempotent replay)
  readonly kind: "entry";
  readonly drawer_id: string;
  readonly line_id: string;
  readonly created_at: string;
  readonly body: Record<string, unknown>;   // the POST /drawers/:id/entries body (ciphertext + plaintext columns)
}
export interface OutboxOps {
  readonly id: string;
  readonly kind: "ops";
  readonly drawer_id: string;
  readonly created_at: string;
  readonly sealed: { nonce: string; ciphertext: string };   // canonicalJson(ops) sealed under the drawer key
  readonly verification: boolean;
}
export type OutboxItem = OutboxEntry | OutboxOps;

const key = (userId: string) => `outbox.${userId}`;

export async function outboxList(userId: string): Promise<OutboxItem[]> {
  return (await idb.get<OutboxItem[]>(key(userId))) ?? [];
}
export async function outboxPush(userId: string, item: OutboxItem): Promise<void> {
  const list = await outboxList(userId);
  if (list.some((x) => x.id === item.id)) return;
  await idb.set(key(userId), [...list, item]);
}
export async function outboxRemove(userId: string, id: string): Promise<void> {
  const list = await outboxList(userId);
  await idb.set(key(userId), list.filter((x) => x.id !== id));
}
export async function outboxClear(userId: string): Promise<void> { await idb.del(key(userId)); }
export const OUTBOX_OLD_MS = 24 * 3_600_000;
