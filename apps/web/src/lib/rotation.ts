/**
 * Key rotation, client side (SPEC-ISSUES A7): publish the new key with a wrap
 * for every remaining member first, then re-seal old rows in batches. Any
 * write member can run it; it resumes from the server's status after a reload.
 */
import { createDrawerKey, fromB64, reseal, toB64, unwrapDrawerKey, wrapDrawerKey, type DrawerKeyWrapV1, type RecordIdentity } from "@petty/crypto";
import type { DrawerKeyWrap, Member } from "@petty/protocol";
import { api } from "./api.js";
import { withCustodyProof } from "./custody.js";
import { getDrawers, loadAll, openWrap, patchRotation, type DrawerView } from "./drawers.js";
import { confirmedFor, getPin, memberStatus, pinStatus, pinsReady } from "./pins.js";
import { getAuth } from "./session.js";

const BATCH = 200;

export class KeyNotConfirmed extends Error { constructor(readonly userId: string) { super("KeyNotConfirmed"); this.name = "KeyNotConfirmed"; } }

function me() { const a = getAuth(); if (a.status !== "unlocked") throw new Error("vault locked"); return a; }

/**
 * A member's ECDH key as pinned; refuses a member whose published key differs from the pin (SPEC "refuses
 * further wraps until re-confirmed"). PETTY-398: and a member whose safety number this person has not
 * confirmed. The server lists the members, so one it added could be the server itself; the new key, and
 * with it everything re-sealed under it, would be readable to it. Rotation waits until they are confirmed.
 */
function pinnedEcdh(m: Member): string {
  const a = me();
  if (m.user_id === a.me.id) return a.keys.pub.ecdh;
  const p = getPin(m.user_id);
  if (!p || pinStatus(m) !== "confirmed") throw new KeyNotConfirmed(m.user_id);
  return p.ecdh;
}

/**
 * PETTY-438: a drawer is re-sealed only under a key that I wrapped, or that a member I confirmed wrapped, and only while my user document is in place.
 * PETTY-449: not under a key from someone I know left the drawer, newer than the last one they held.
 */
function wrappedByConfirmed(wrap: DrawerKeyWrap, meId: string): boolean {
  if (!pinsReady()) return false;
  return wrap.sender_id === meId || (!!wrap.sender_id && confirmedFor(wrap.drawer_id, wrap.sender_id, wrap.key_version));
}

/** Step 1 + 2: new key generation, wraps for everyone still in, publish. Then the batches. */
export async function rotateDrawer(id: string): Promise<void> {
  const a = me();
  const view = getDrawers().drawers.get(id);
  if (!view?.key) throw new Error("drawer not ready");
  if (!pinsReady()) throw new Error("PinsRolledBack"); // PETTY-438: no rotation while the user document is missing, rolled back or not loaded
  // PETTY-449: someone I know left this drawer, and whom the server lists again, gets no new key until I confirm them again
  const back = view.members.find((m) => m.user_id !== a.me.id && memberStatus(id, m) !== "confirmed");
  if (back) throw new KeyNotConfirmed(back.user_id);
  const toVersion = view.summary.key_version + 1;
  const sender = { ecdhPrivate: a.keys.ecdhPrivate, ecdhPublicB64: a.keys.pub.ecdh };
  const { selfWrap } = await createDrawerKey(sender, id, toVersion);
  const newKeyExtractable = await unwrapDrawerKey(selfWrap, a.keys.ecdhPrivate, { drawer_id: id, key_version: toVersion, senderEcdhPublicB64: a.keys.pub.ecdh }, { extractable: true });
  const wraps: Array<{ user_id: string; wrap: DrawerKeyWrapV1 }> = [];
  for (const m of view.members) {
    wraps.push({ user_id: m.user_id, wrap: await wrapDrawerKey(newKeyExtractable, sender, pinnedEcdh(m), id, toVersion) });
  }
  await withCustodyProof(a.keys.ecdsaPrivate, (proof) => api("POST", `/drawers/${id}/rotation`, { to_version: toVersion, wraps, proof }));
  await loadAll(); // picks up the new key version and my new wrap
  await continueRotation(id);
}

/** Step 3, resumable: re-seal every row still under an older key version, in batches, until the server reports completion. */
export async function continueRotation(id: string): Promise<void> {
  const a = me();
  const view = getDrawers().drawers.get(id);
  if (!view?.key) throw new Error("drawer not ready");
  // PETTY-438: nothing is re-sealed, and nothing is asked for, unless the new key came from me or from a member I confirmed
  const current = view.wraps.find((w) => w.key_version === view.summary.key_version);
  if (!current || !wrappedByConfirmed(current, a.me.id)) throw new KeyNotConfirmed(current?.sender_id ?? "");
  const status = await api<{ key_version: number; pending_entries: number; document_pending: boolean; photo_pending: boolean; completed: boolean }>("GET", `/drawers/${id}/rotation`);
  if (status.completed) { patchRotation(id, null); return; }
  const toVersion = status.key_version;
  if (toVersion !== current.key_version) throw new Error("rotation moved on"); // only to the key version just checked; the next load takes a newer one
  const opened = await openWrap(id, toVersion, current, view.members); // the key of that very wrap, not one opened earlier
  if ("error" in opened) throw new KeyNotConfirmed(current.sender_id ?? "");
  const newKey = opened.key;
  const oldKeys = new Map<number, CryptoKey>();
  const oldKeyFor = async (version: number): Promise<CryptoKey> => {
    const cached = oldKeys.get(version);
    if (cached) return cached;
    const wrap = view.wraps.find((w) => w.key_version === version);
    if (!wrap) throw new Error(`no wrap for key version ${version}`);
    const old = await openWrap(id, version, wrap, view.members);
    if ("error" in old) throw new KeyNotConfirmed(wrap.sender_id ?? "");
    oldKeys.set(version, old.key);
    return old.key;
  };
  const exp = await api<{ document: { author_id: string; key_version: number; nonce: string; ciphertext: string; schema_version: number }; photo: { author_id: string; key_version: number; nonce: string; ciphertext: string } | null; entries: Array<{ id: string; line_id: string; author_id: string; key_version: number; schema_version: number; nonce: string; ciphertext: string }> }>("GET", `/drawers/${id}/export`);
  const pending = exp.entries.filter((e) => e.key_version < toVersion);
  const total = pending.length;
  patchRotation(id, { total, done: 0 });
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = [];
    for (const row of pending.slice(i, i + BATCH)) {
      const identity: RecordIdentity = { record_type: "entry", record_id: row.id, drawer_id: id, line_id: row.line_id, author_id: row.author_id, key_version: row.key_version, schema_version: row.schema_version };
      const r = await reseal(await oldKeyFor(row.key_version), newKey, identity, { nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) }, toVersion);
      batch.push({ id: row.id, nonce: toB64(r.sealed.nonce), ciphertext: toB64(r.sealed.ciphertext) });
    }
    const body: Record<string, unknown> = { to_version: toVersion, entries: batch };
    const last = i + BATCH >= pending.length;
    if (last && exp.document.key_version < toVersion) {
      const d = exp.document;
      const r = await reseal(await oldKeyFor(d.key_version), newKey, { record_type: "document", record_id: id, drawer_id: id, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) }, toVersion);
      body["document"] = { key_version: toVersion, schema_version: d.schema_version, nonce: toB64(r.sealed.nonce), ciphertext: toB64(r.sealed.ciphertext) };
    }
    if (last && exp.photo && exp.photo.key_version < toVersion) {
      const p = exp.photo;
      const r = await reseal(await oldKeyFor(p.key_version), newKey, { record_type: "photo", record_id: id, drawer_id: id, line_id: null, author_id: p.author_id, key_version: p.key_version, schema_version: 1 }, { nonce: fromB64(p.nonce), ciphertext: fromB64(p.ciphertext) }, toVersion);
      body["photo"] = { key_version: toVersion, schema_version: 1, nonce: toB64(r.sealed.nonce), ciphertext: toB64(r.sealed.ciphertext) };
    }
    const s = await withCustodyProof(a.keys.ecdsaPrivate, (proof) => api<{ completed: boolean; pending_entries: number }>("PUT", `/drawers/${id}/rotation/batch`, { ...body, proof }));
    patchRotation(id, s.completed ? null : { total, done: Math.min(total, i + BATCH) });
    if (s.completed) break;
  }
  if (pending.length === 0) {
    // only the document / photo were pending
    const body: Record<string, unknown> = { to_version: toVersion, entries: [] };
    if (exp.document.key_version < toVersion) {
      const d = exp.document;
      const r = await reseal(await oldKeyFor(d.key_version), newKey, { record_type: "document", record_id: id, drawer_id: id, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) }, toVersion);
      body["document"] = { key_version: toVersion, schema_version: d.schema_version, nonce: toB64(r.sealed.nonce), ciphertext: toB64(r.sealed.ciphertext) };
    }
    if (exp.photo && exp.photo.key_version < toVersion) {
      const p = exp.photo;
      const r = await reseal(await oldKeyFor(p.key_version), newKey, { record_type: "photo", record_id: id, drawer_id: id, line_id: null, author_id: p.author_id, key_version: p.key_version, schema_version: 1 }, { nonce: fromB64(p.nonce), ciphertext: fromB64(p.ciphertext) }, toVersion);
      body["photo"] = { key_version: toVersion, schema_version: 1, nonce: toB64(r.sealed.nonce), ciphertext: toB64(r.sealed.ciphertext) };
    }
    await withCustodyProof(a.keys.ecdsaPrivate, (proof) => api("PUT", `/drawers/${id}/rotation/batch`, { ...body, proof }));
    patchRotation(id, null);
  }
}

export type { DrawerView, DrawerKeyWrap };
