/**
 * Key pinning (spec "Key verification"). Pins live in the user's own encrypted
 * document on the server, sealed under a key only this user can derive (ECDH
 * with their own public key → HKDF). A server that swaps a contact's published
 * key cannot touch the pin, so the change is detected and shown.
 */
import { useSyncExternalStore } from "react";
import { fromB64, hkdfAesKey, importEcdhPublic, open, seal, safetyNumber, toB64, utf8, fromUtf8, canonicalJson, type RecordIdentity } from "@petty/crypto";
import { UserDocRow, type Member } from "@petty/protocol";
import { z } from "zod";
import { api, ApiError } from "./api.js";
import { idb } from "./idb.js";
import { getAuth } from "./session.js";

const Pin = z.object({ ecdh: z.string(), ecdsa: z.string(), sig_key_id: z.string(), pinned_at: z.string(), confirmed_at: z.string().nullable() });
// `excluded_from_total` (PETTY-38): drawers this person does not count in the home TOTAL —
// optional, so documents written before it existed still parse. Older builds ignore it.
// `hide_places` (PETTY-59): this person wants a plain list on the home screen, no place chips or groups.
// `places` (PETTY-66): this person's tree of places; each node's path of names is what a drawer stores.
// `line_tags` (PETTY-152): this person's tag list for items, across all drawers; merged on read with the tags found on drawers.
interface PlaceNodeT { readonly name: string; readonly children: readonly PlaceNodeT[] }
// `tokens` (PETTY-181, security review NR-1): the access tokens THIS person made, with a fingerprint of
// each token's ECDH public key. Drawer keys are wrapped only to tokens listed here. The list lives in the
// sealed user document, so the server can neither add a token to it nor swap a key.
const TrustedToken = z.object({ id: z.string(), pub_fp: z.string(), scope: z.array(z.string()).nullable(), expires_at: z.string().nullable() });
export type TrustedToken = z.infer<typeof TrustedToken>;
const PlaceNode: z.ZodType<PlaceNodeT> = z.lazy(() => z.object({ name: z.string(), children: z.array(PlaceNode).readonly() }));
const UserDoc = z.object({ v: z.literal(1), pins: z.record(z.string(), Pin), excluded_from_total: z.array(z.string()).optional(), hide_places: z.boolean().optional(), hide_verification: z.boolean().optional(), hide_totals: z.boolean().optional(), places: z.array(PlaceNode).optional(), line_tags: z.array(z.string()).optional(), tokens: z.array(TrustedToken).optional() });
export type Pin = z.infer<typeof Pin>;
type UserDocT = z.infer<typeof UserDoc>;

/**
 * rolled_back (SR-3): the server answered 404, or a lower version than this device last
 * saw. Pins stay as they were in memory, nothing new is pinned and no key is wrapped for
 * anyone until the user acknowledges it; otherwise a server that drops the document
 * would turn every confirmed pin back into first sight.
 */
interface PinsState { readonly status: "idle" | "ready" | "rolled_back"; readonly doc: UserDocT; readonly version: number; readonly lastSeenVersion: number }
let state: PinsState = { status: "idle", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 };
const seenKey = (userId: string) => `userdoc.${userId}`;
const listeners = new Set<() => void>();
function set(next: PinsState): void { state = next; for (const l of listeners) l(); }
export function usePins(): PinsState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export function resetPins(): void { set({ status: "idle", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 }); }
export function pinsBlocked(): boolean { return state.status === "rolled_back"; }
/** The user read the warning and chose to start over: forget the remembered version and load whatever the server has. */
export async function acknowledgeRollback(): Promise<void> {
  const a = getAuth();
  if (a.status !== "unlocked") return;
  await idb.del(seenKey(a.me.id));
  set({ ...state, status: "idle", lastSeenVersion: 0 });
  await loadPins();
}

let selfKey: CryptoKey | null = null;
async function key(): Promise<{ key: CryptoKey; identity: RecordIdentity }> {
  const a = getAuth();
  if (a.status !== "unlocked") throw new Error("vault locked");
  if (!selfKey) {
    const myPub = await importEcdhPublic(a.me.pub.ecdh);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: myPub }, a.keys.ecdhPrivate, 256));
    selfKey = await hkdfAesKey(shared, utf8("petty/self-doc/v1"), utf8(a.me.id), "AES-GCM", ["encrypt", "decrypt"]);
  }
  return { key: selfKey, identity: { record_type: "document", record_id: a.me.id, drawer_id: a.me.id, line_id: null, author_id: a.me.id, key_version: 1, schema_version: 1 } };
}
export function forgetSelfKey(): void { selfKey = null; resetPins(); }

export async function loadPins(): Promise<void> {
  const { key: k, identity } = await key();
  const userId = identity.record_id;
  const seen = (await idb.get<{ version: number }>(seenKey(userId)))?.version ?? 0;
  try {
    const raw = await api<unknown>("GET", "/me/doc");
    if (raw === undefined) { // 204: no document yet (PETTY-133)
      if (seen > 0) { set({ status: "rolled_back", doc: state.doc, version: 0, lastSeenVersion: seen }); return; }
      set({ status: "ready", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 });
      return;
    }
    const row = UserDocRow.parse(raw);
    const doc = UserDoc.parse(JSON.parse(fromUtf8(await open(k, identity, { nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) }))));
    if (row.version < seen) { set({ status: "rolled_back", doc, version: row.version, lastSeenVersion: seen }); return; }
    await idb.set(seenKey(userId), { version: row.version });
    set({ status: "ready", doc, version: row.version, lastSeenVersion: row.version });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      if (seen > 0) { set({ status: "rolled_back", doc: state.doc, version: 0, lastSeenVersion: seen }); return; }
      set({ status: "ready", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 });
      return;
    }
    throw e;
  }
}

async function save(mutate: (doc: UserDocT) => UserDocT): Promise<void> {
  const { key: k, identity } = await key();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (state.status === "idle") await loadPins();
    if (state.status === "rolled_back") throw new Error("PinsRolledBack");
    const next = mutate(state.doc);
    const sealed = await seal(k, identity, utf8(canonicalJson(next)));
    try {
      const r = await api<{ version: number }>("PUT", "/me/doc", { base_version: state.version, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) });
      await idb.set(seenKey(identity.record_id), { version: r.version });
      set({ status: "ready", doc: next, version: r.version, lastSeenVersion: r.version });
      return;
    } catch (e) {
      if (e instanceof ApiError && e.code === "VersionConflict") { await loadPins(); continue; }
      throw e;
    }
  }
}

export function getPin(userId: string): Pin | null { return state.doc.pins[userId] ?? null; }

/** Drawers this person keeps out of the home TOTAL (PETTY-38). Per person: a shared drawer can count for one member and not another. */
export function excludedFromTotal(doc: UserDocT = state.doc): ReadonlySet<string> { return new Set(doc.excluded_from_total ?? []); }
export async function setCountedInTotal(drawerId: string, counted: boolean): Promise<void> {
  const mutate = (doc: UserDocT): UserDocT => {
    const ex = new Set(doc.excluded_from_total ?? []);
    if (counted) ex.delete(drawerId); else ex.add(drawerId);
    return { ...doc, excluded_from_total: [...ex].sort() };
  };
  // Optimistic: the switch is a controlled input and must flip at once, not after the seal + PUT round trip.
  set({ ...state, doc: mutate(state.doc) });
  try { await save(mutate); } catch (e) { await loadPins().catch(() => undefined); throw e; }
}

/** Places on the home screen (PETTY-59): on unless this person switched them off. Synced with the user document. */
export function placesShown(doc: UserDocT = state.doc): boolean { return !doc.hide_places; }
export async function setPlacesShown(shown: boolean): Promise<void> {
  const mutate = (doc: UserDocT): UserDocT => { const next = { ...doc }; if (shown) delete next.hide_places; else next.hide_places = true; return next; };
  set({ ...state, doc: mutate(state.doc) });
  try { await save(mutate); } catch (e) { await loadPins().catch(() => undefined); throw e; }
}

/** Verification on show (PETTY-83): the Confirm state bar, the history and the badges — off for someone who never counts and confirms. */
export function verificationShown(doc: UserDocT = state.doc): boolean { return !doc.hide_verification; }
export async function setVerificationShown(shown: boolean): Promise<void> {
  const mutate = (doc: UserDocT): UserDocT => { const next = { ...doc }; if (shown) delete next.hide_verification; else next.hide_verification = true; return next; };
  set({ ...state, doc: mutate(state.doc) });
  try { await save(mutate); } catch (e) { await loadPins().catch(() => undefined); throw e; }
}

/** Totals on show (PETTY-84): the home Total value card and subtotals, the drawer totals card and the in-total chips. */
export function totalsShown(doc: UserDocT = state.doc): boolean { return !doc.hide_totals; }
export async function setTotalsShown(shown: boolean): Promise<void> {
  const mutate = (doc: UserDocT): UserDocT => { const next = { ...doc }; if (shown) delete next.hide_totals; else next.hide_totals = true; return next; };
  set({ ...state, doc: mutate(state.doc) });
  try { await save(mutate); } catch (e) { await loadPins().catch(() => undefined); throw e; }
}

/** The saved place tree (PETTY-66). */
export function placesTree(doc: UserDocT = state.doc): readonly PlaceNodeT[] { return doc.places ?? []; }
export async function setPlacesTree(places: readonly PlaceNodeT[]): Promise<void> {
  const copy = JSON.parse(JSON.stringify(places)) as PlaceNodeT[];
  const mutate = (doc: UserDocT): UserDocT => (copy.length ? { ...doc, places: copy } : (() => { const next = { ...doc }; delete next.places; return next; })());
  set({ ...state, doc: mutate(state.doc) });
  try { await save(mutate); } catch (e) { await loadPins().catch(() => undefined); throw e; }
}

/** This person's saved item tags (PETTY-152), in their chosen spelling. */
export function savedLineTags(doc: UserDocT = state.doc): readonly string[] { return doc.line_tags ?? []; }
export async function updateSavedLineTags(change: (tags: readonly string[]) => readonly string[]): Promise<void> {
  const mutate = (doc: UserDocT): UserDocT => {
    const next = { ...doc };
    const tags = [...change(doc.line_tags ?? [])];
    if (tags.length) next.line_tags = tags; else delete next.line_tags;
    return next;
  };
  set({ ...state, doc: mutate(state.doc) });
  try { await save(mutate); } catch (e) { await loadPins().catch(() => undefined); throw e; }
}

/** The access tokens this person made (PETTY-181), as recorded in the sealed user document. */
export function trustedTokens(doc: UserDocT = state.doc): readonly TrustedToken[] { return doc.tokens ?? []; }
export async function updateTrustedTokens(change: (tokens: readonly TrustedToken[]) => readonly TrustedToken[]): Promise<void> {
  const mutate = (doc: UserDocT): UserDocT => {
    const next = { ...doc };
    const list = [...change(doc.tokens ?? [])];
    if (list.length) next.tokens = list; else delete next.tokens;
    return next;
  };
  set({ ...state, doc: mutate(state.doc) });
  try { await save(mutate); } catch (e) { await loadPins().catch(() => undefined); throw e; }
}

/** Trust on first use: remember the keys we saw. Never overwrites an existing pin. */
export async function pinIfNew(m: Member): Promise<void> {
  if (pinsBlocked() || !m.keys || state.doc.pins[m.user_id]) return;
  const k = m.keys;
  await save((doc) => ({ ...doc, pins: { ...doc.pins, [m.user_id]: { ecdh: k.ecdh_pub, ecdsa: k.ecdsa_pub, sig_key_id: k.sig_key_id, pinned_at: new Date().toISOString(), confirmed_at: null } } }));
}

/** Trust on first use for a whole member list, saved once. */
export async function pinMembers(members: readonly Member[]): Promise<void> {
  if (pinsBlocked()) return;
  const fresh = members.filter((m) => m.keys && !state.doc.pins[m.user_id]);
  if (!fresh.length) return;
  await save((doc) => {
    const pins = { ...doc.pins };
    for (const m of fresh) if (m.keys && !pins[m.user_id]) pins[m.user_id] = { ecdh: m.keys.ecdh_pub, ecdsa: m.keys.ecdsa_pub, sig_key_id: m.keys.sig_key_id, pinned_at: new Date().toISOString(), confirmed_at: null };
    return { ...doc, pins };
  });
}

/** The user compared the safety number out of band (or accepted a key change): pin these keys as confirmed. */
export async function confirmPin(userId: string, keys: { ecdh_pub: string; ecdsa_pub: string; sig_key_id: string }): Promise<void> {
  await save((doc) => ({ ...doc, pins: { ...doc.pins, [userId]: { ecdh: keys.ecdh_pub, ecdsa: keys.ecdsa_pub, sig_key_id: keys.sig_key_id, pinned_at: doc.pins[userId]?.pinned_at ?? new Date().toISOString(), confirmed_at: new Date().toISOString() } } }));
}

export type PinStatus = "unpinned" | "unconfirmed" | "confirmed" | "changed";
/** How the member's currently published keys relate to what we pinned. */
export function pinStatus(m: Member): PinStatus {
  const p = state.doc.pins[m.user_id];
  if (!m.keys) return "unpinned";
  if (!p) return "unpinned";
  if (p.ecdh !== m.keys.ecdh_pub || p.ecdsa !== m.keys.ecdsa_pub) return "changed";
  return p.confirmed_at ? "confirmed" : "unconfirmed";
}

export async function memberSafetyNumber(m: Member): Promise<string> {
  return m.keys ? safetyNumber({ ecdh: m.keys.ecdh_pub, ecdsa: m.keys.ecdsa_pub }) : "";
}
