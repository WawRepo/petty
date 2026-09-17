/**
 * Key rotation, client side (SPEC-ISSUES A7): publish the new key with a wrap
 * for every remaining member first, then re-seal old rows in batches. Any
 * write member can run it; it resumes from the server's status after a reload.
 */
import { createDrawerKey, fromB64, reseal, toB64, unwrapDrawerKey, wrapDrawerKey, type DrawerKeyWrapV1, type RecordIdentity } from "@petty/crypto";
import type { DrawerKeyWrap, Member } from "@petty/protocol";
import { api } from "./api.js";
import { expectedSender, getDrawers, loadAll, patchRotation, type DrawerView } from "./drawers.js";
import { getPin } from "./pins.js";
import { getAuth } from "./session.js";

const BATCH = 200;

export class KeyNotConfirmed extends Error { constructor(readonly userId: string) { super("KeyNotConfirmed"); this.name = "KeyNotConfirmed"; } }

function me() { const a = getAuth(); if (a.status !== "unlocked") throw new Error("vault locked"); return a; }

/** A member's ECDH key as pinned; refuses a member whose published key differs from the pin (SPEC "refuses further wraps until re-confirmed"). */
function pinnedEcdh(m: Member): string {
  const a = me();
  if (m.user_id === a.me.id) return a.me.pub.ecdh;
  const p = getPin(m.user_id);
  if (!p || !m.keys || p.ecdh !== m.keys.ecdh_pub) throw new KeyNotConfirmed(m.user_id);
  return p.ecdh;
}

/** Step 1 + 2: new key generation, wraps for everyone still in, publish. Then the batches. */
export async function rotateDrawer(id: string): Promise<void> {
  const a = me();
  const view = getDrawers().drawers.get(id);
  if (!view?.key) throw new Error("drawer not ready");
  const toVersion = view.summary.key_version + 1;
  const sender = { ecdhPrivate: a.keys.ecdhPrivate, ecdhPublicB64: a.me.pub.ecdh };
  const { selfWrap } = await createDrawerKey(sender, id, toVersion);
  const newKeyExtractable = await unwrapDrawerKey(selfWrap, a.keys.ecdhPrivate, { drawer_id: id, key_version: toVersion, senderEcdhPublicB64: a.me.pub.ecdh }, { extractable: true });
  const wraps: Array<{ user_id: string; wrap: DrawerKeyWrapV1 }> = [];
  for (const m of view.members) {
    wraps.push({ user_id: m.user_id, wrap: await wrapDrawerKey(newKeyExtractable, sender, pinnedEcdh(m), id, toVersion) });
  }
  await api("POST", `/drawers/${id}/rotation`, { to_version: toVersion, wraps });
  await loadAll(); // picks up the new key version and my new wrap
  await continueRotation(id);
}

/** Step 3, resumable: re-seal every row still under an older key version, in batches, until the server reports completion. */
export async function continueRotation(id: string): Promise<void> {
  const a = me();
  const view = getDrawers().drawers.get(id);
  if (!view?.key) throw new Error("drawer not ready");
  const status = await api<{ key_version: number; pending_entries: number; document_pending: boolean; photo_pending: boolean; completed: boolean }>("GET", `/drawers/${id}/rotation`);
  if (status.completed) { patchRotation(id, null); return; }
  const toVersion = status.key_version;
  const newKey = view.key; // loadAll unwrapped the current (new) version
  const oldKeys = new Map<number, CryptoKey>();
  const oldKeyFor = async (version: number): Promise<CryptoKey> => {
    const cached = oldKeys.get(version);
    if (cached) return cached;
    const wrap = view.wraps.find((w) => w.key_version === version);
    if (!wrap) throw new Error(`no wrap for key version ${version}`);
    const sender = await expectedSender(wrap, view.members);
    if ("error" in sender) throw new KeyNotConfirmed(wrap.sender_id ?? "");
    const k = await unwrapDrawerKey(wrap, a.keys.ecdhPrivate, { drawer_id: id, key_version: version, senderEcdhPublicB64: sender.pub });
    oldKeys.set(version, k);
    return k;
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
    const s = await api<{ completed: boolean; pending_entries: number }>("PUT", `/drawers/${id}/rotation/batch`, body);
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
    await api("PUT", `/drawers/${id}/rotation/batch`, body);
    patchRotation(id, null);
  }
}

export type { DrawerView, DrawerKeyWrap };
