import { HISTORY_DAYS } from "./maintenance.js";
import type { Queryable } from "./tx.js";

/**
 * PETTY-506: copies of a replaced user document and of a replaced or removed drawer photo (migration 023).
 * They are kept HISTORY_DAYS (30) days, like a replaced drawer document, so the person's own app can put one
 * back. The server cannot read them and never chooses one.
 *
 * How many: the KEPT_NEWEST newest, plus the first copy replaced on each day. A drawer document keeps every
 * copy for 30 days, bounded by the owner's storage quota. A user document is not part of the quota (it is no
 * drawer's), and a photo copy is up to 300 KiB, so here a count bounds them too. A plain "newest N" would let
 * a writer that replaces the same thing N times in a row (a script with a stolen session) push out every copy
 * from before it; the first copy of each day still holds the state from before that day's writes. Together
 * that is at most about 40 copies per person or drawer.
 */
export const KEPT_NEWEST = 10;

type Kept = { table: "user_doc_history"; owner: "user_id" } | { table: "drawer_photo_history"; owner: "drawer_id" };
const USER_DOC: Kept = { table: "user_doc_history", owner: "user_id" };
const PHOTO: Kept = { table: "drawer_photo_history", owner: "drawer_id" };

/** Drops the copies of one person or drawer past the rule above. Called after each copy is kept. */
async function prune(db: Queryable, k: Kept, ownerId: string): Promise<void> {
  await db.query(
    `delete from ${k.table} h where h.${k.owner} = $1 and (
       h.replaced_at < now() - make_interval(days => $2)
       or (h.id not in (select id from ${k.table} where ${k.owner} = $1 order by replaced_at desc, id desc limit $3)
           and h.id not in (select distinct on (date_trunc('day', replaced_at)) id from ${k.table} where ${k.owner} = $1
                             order by date_trunc('day', replaced_at), replaced_at, id)))`,
    [ownerId, HISTORY_DAYS, KEPT_NEWEST],
  );
}

/** Keeps the person's current user document (if any) before it is replaced. Inside the write's transaction, after its row lock. */
export async function keepUserDoc(db: Queryable, userId: string): Promise<void> {
  const r = await db.query(
    `insert into user_doc_history (user_id, version, schema_version, nonce, ciphertext, written_at)
     select user_id, version, schema_version, nonce, ciphertext, updated_at from user_docs where user_id = $1`,
    [userId],
  );
  if (r.rowCount) await prune(db, USER_DOC, userId);
}

/** Keeps a drawer's current photo (if any) before it is replaced (`removed` false) or deleted (true). Locks the photo row. */
export async function keepPhoto(db: Queryable, drawerId: string, userId: string, removed: boolean): Promise<number> {
  const old = (await db.query<{ n: number }>("select octet_length(ciphertext) as n from drawer_photos where drawer_id = $1 for update", [drawerId])).rows[0];
  if (!old) return 0;
  await db.query(
    `insert into drawer_photo_history (drawer_id, author_id, key_version, schema_version, nonce, ciphertext, written_at, replaced_by, removed)
     select drawer_id, author_id, key_version, schema_version, nonce, ciphertext, updated_at, $2, $3 from drawer_photos where drawer_id = $1`,
    [drawerId, userId, removed],
  );
  await prune(db, PHOTO, drawerId);
  return old.n;
}
