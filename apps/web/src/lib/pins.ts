/**
 * Key pinning (spec "Key verification"). Pins live in the user's own encrypted
 * document on the server, sealed under a key only this user can derive (ECDH
 * with their own public key → HKDF). A server that swaps a contact's published
 * key cannot touch the pin, so the change is detected and shown.
 */
import { useSyncExternalStore } from "react";
import { fromB64, hkdfAesKey, importEcdhPublic, open, seal, safetyNumber, toB64, utf8, fromUtf8, canonicalJson, type RecordIdentity } from "@petty/crypto";
import { UserDocRow, z, type Member } from "@petty/protocol";
import { api, ApiError, NetworkError } from "./api.js";
import { idb } from "./idb.js";
import { getAuth } from "./session.js";

// `earlier` (PETTY-413): the signing keys this person confirmed for the contact before the current one, so that entries
// those keys signed still verify. A key that was pinned on first sight and never confirmed is not kept.
const Pin = z.object({ ecdh: z.string(), ecdsa: z.string(), sig_key_id: z.string(), pinned_at: z.string(), confirmed_at: z.string().nullable(), earlier: z.array(z.object({ ecdsa: z.string(), sig_key_id: z.string() })).optional() });
// `excluded_from_total` (PETTY-38): drawers this person does not count in the home TOTAL —
// optional, so documents written before it existed still parse. Older builds ignore it.
// `hide_places` (PETTY-59): this person wants a plain list on the home screen, no place chips or groups.
// `hide_picture` (PETTY-257): no picture on the home screen, only the total and the list.
// `places` (PETTY-66): this person's tree of places; each node's path of names is what a drawer stores.
// `line_tags` (PETTY-152): this person's tag list for items, across all drawers; merged on read with the tags found on drawers.
interface PlaceNodeT { readonly name: string; readonly children: readonly PlaceNodeT[] }
// `tokens` (PETTY-181, security review NR-1): the access tokens THIS person made, with a fingerprint of
// each token's ECDH public key. Drawer keys are wrapped only to tokens listed here. The list lives in the
// sealed user document, so the server can neither add a token to it nor swap a key.
const TrustedToken = z.object({ id: z.string(), pub_fp: z.string(), scope: z.array(z.string()).nullable(), expires_at: z.string().nullable() });
export type TrustedToken = z.infer<typeof TrustedToken>;
// `drawer_keys` (PETTY-398): per drawer, the highest key version this person has accepted. A newer one is a
// rotation and is taken only from a confirmed member; an older one means the server went back to a key a
// removed member may still hold. Sealed here, so the server can neither raise nor lower it.
// `drawer_docs` (PETTY-403): per drawer, the newest document version this person opened. An older one means
// the server went back to an earlier state of the drawer: lines added since gone, with their balances.
// `drawer_key_fps` (PETTY-438): per drawer and key version, a fingerprint of the key this person accepted. Another
// key at the same version is refused. A document without it (written before, or saved by an older Petty, which drops
// the field) keeps the drawer open at the version in `drawer_keys`, and the fingerprint is remembered at the next load.
// `drawer_members` (PETTY-449): per drawer, the other people this person saw as its members. One who is no longer
// listed left the drawer or was removed from it.
// `drawer_left` (PETTY-449): per drawer, the people this person knows left it or were removed, each with the newest
// key version they may still hold. While the drawer is at that version its key is owed a replacement, whatever the
// server says. A newer key that such a person wrapped is not taken until this person confirms them again.
const PlaceNode: z.ZodType<PlaceNodeT> = z.lazy(() => z.object({ name: z.string(), children: z.array(PlaceNode).readonly() }));
const UserDoc = z.object({ v: z.literal(1), pins: z.record(z.string(), Pin), excluded_from_total: z.array(z.string()).optional(), hide_places: z.boolean().optional(), hide_verification: z.boolean().optional(), hide_totals: z.boolean().optional(), hide_picture: z.boolean().optional(), places: z.array(PlaceNode).optional(), line_tags: z.array(z.string()).optional(), tokens: z.array(TrustedToken).optional(), drawer_keys: z.record(z.string(), z.number().int().positive()).optional(), drawer_docs: z.record(z.string(), z.number().int().positive()).optional(), drawer_key_fps: z.record(z.string(), z.record(z.string(), z.string())).optional(), drawer_members: z.record(z.string(), z.array(z.string())).optional(), drawer_left: z.record(z.string(), z.record(z.string(), z.number().int().positive())).optional() });
export type Pin = z.infer<typeof Pin>;
type UserDocT = z.infer<typeof UserDoc>;

/**
 * rolled_back (SR-3): the server answered 404, or a lower version than this device last
 * saw. Pins stay as they were in memory, nothing new is pinned and no key is wrapped for
 * anyone until the user acknowledges it; otherwise a server that drops the document
 * would turn every confirmed pin back into first sight.
 * PETTY-438: no document at all counts the same when the account has drawers (`drawersNeedUserDoc`).
 * While rolled back, and while "idle" (not loaded), only drawer keys this person wrapped are opened.
 */
interface PinsState { readonly status: "idle" | "ready" | "rolled_back"; readonly doc: UserDocT; readonly version: number; readonly lastSeenVersion: number }
let state: PinsState = { status: "idle", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 };
const seenKey = (userId: string) => `userdoc.${userId}`;
/** PETTY-438: the sealed document as last loaded or saved here, for a start with no connection. Ciphertext only; wiped at sign-out with the rest of the cache. */
const K_DOC = "cache.userdoc";
interface CachedDoc { readonly userId: string; readonly version: number; readonly nonce: string; readonly ciphertext: string }
const listeners = new Set<() => void>();
function set(next: PinsState): void { state = next; for (const l of listeners) l(); }
export function usePins(): PinsState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export function resetPins(): void { set({ status: "idle", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 }); }
export function pinsBlocked(): boolean { return state.status === "rolled_back"; }
/**
 * PETTY-438: the user document is loaded and not rolled back. Only then does the app open a drawer key that someone
 * else wrapped, or re-seal a drawer. Missing, rolled back or not loaded all mean: keys this person wrapped, nothing more.
 */
export function pinsReady(): boolean { return state.status === "ready"; }
/**
 * PETTY-438: the account has drawers, so it has a user document: the app starts one before it makes a drawer, and
 * accepting an invitation saves the inviter's pin. When the server has none, that counts as rolled back, also on a
 * browser that never saw one.
 */
export function drawersNeedUserDoc(): void { if (state.status === "ready" && state.version === 0) set({ ...state, status: "rolled_back" }); }
/** PETTY-438: saves a first, empty user document when the server has none, so that an account with drawers always has one. */
export async function startUserDoc(): Promise<void> {
  if (state.status === "idle") await loadPins();
  if (state.status === "ready" && state.version === 0) await save((doc) => doc);
}
/** The user read the warning and chose to start over: forget the remembered version and load whatever the server has. */
export async function acknowledgeRollback(): Promise<void> {
  const a = getAuth();
  if (a.status !== "unlocked") return;
  await idb.del(seenKey(a.me.id));
  await idb.del(K_DOC);
  set({ ...state, status: "idle", lastSeenVersion: 0 });
  await loadPins();
  await startUserDoc(); // PETTY-438: the new list exists on the server from now on, so the next load does not miss it again
}
/** The account was deleted: its remembered version goes with it. A sign-out keeps it (PETTY-402). */
export async function forgetUserDocVersion(userId: string): Promise<void> { await idb.del(seenKey(userId)); }

let selfKey: CryptoKey | null = null;
async function key(): Promise<{ key: CryptoKey; identity: RecordIdentity }> {
  const a = getAuth();
  if (a.status !== "unlocked") throw new Error("vault locked");
  if (!selfKey) {
    const myPub = await importEcdhPublic(a.keys.pub.ecdh);
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
      if (state.status === "ready" && state.version > 0) return; // PETTY-438: this page saved the document while this answer was on its way
      set({ status: "ready", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 });
      return;
    }
    const row = UserDocRow.parse(raw);
    const doc = UserDoc.parse(JSON.parse(fromUtf8(await open(k, identity, { nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) }))));
    if (row.version < seen) { set({ status: "rolled_back", doc, version: row.version, lastSeenVersion: seen }); return; }
    await idb.set(seenKey(userId), { version: row.version });
    await idb.set(K_DOC, { userId, version: row.version, nonce: row.nonce, ciphertext: row.ciphertext } satisfies CachedDoc);
    set({ status: "ready", doc, version: row.version, lastSeenVersion: row.version });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      if (seen > 0) { set({ status: "rolled_back", doc: state.doc, version: 0, lastSeenVersion: seen }); return; }
      set({ status: "ready", doc: { v: 1, pins: {} }, version: 0, lastSeenVersion: 0 });
      return;
    }
    // PETTY-438: no connection and nothing loaded yet: the copy this device kept, if it is the newest it saw, still says
    // whom this person confirmed and which keys they accepted. A browser without one opens only keys its user wrapped.
    if (e instanceof NetworkError && state.status === "idle") {
      const c = await idb.get<CachedDoc>(K_DOC);
      if (c && c.userId === userId && c.version >= seen) {
        const doc = UserDoc.parse(JSON.parse(fromUtf8(await open(k, identity, { nonce: fromB64(c.nonce), ciphertext: fromB64(c.ciphertext) }))));
        set({ status: "ready", doc, version: c.version, lastSeenVersion: seen });
      }
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
      await idb.set(K_DOC, { userId: identity.record_id, version: r.version, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) } satisfies CachedDoc);
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

/** The home picture (PETTY-257): the home with the places and drawers round it. On unless switched off. */
export function pictureShown(doc: UserDocT = state.doc): boolean { return !doc.hide_picture; }
export async function setPictureShown(shown: boolean): Promise<void> {
  const mutate = (doc: UserDocT): UserDocT => { const next = { ...doc }; if (shown) delete next.hide_picture; else next.hide_picture = true; return next; };
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

/** The highest key version of this drawer that this person accepted (PETTY-398), or null before the first. */
export function acceptedKeyVersion(drawerId: string, doc: UserDocT = state.doc): number | null { return doc.drawer_keys?.[drawerId] ?? null; }
/** The newest document version of this drawer that this person opened (PETTY-403), or null before the first. */
export function acceptedDocVersion(drawerId: string, doc: UserDocT = state.doc): number | null { return doc.drawer_docs?.[drawerId] ?? null; }
/** The fingerprint of the key this person accepted for this drawer at this key version (PETTY-438), or null when none is remembered. */
export function acceptedKeyFingerprint(drawerId: string, keyVersion: number, doc: UserDocT = state.doc): string | null { return doc.drawer_key_fps?.[drawerId]?.[String(keyVersion)] ?? null; }
function raised(seen: Readonly<Record<string, number>> | undefined, next: ReadonlyMap<string, number>): Record<string, number> | undefined {
  const out = { ...seen };
  for (const [id, v] of next) if (v > (out[id] ?? 0)) out[id] = v;
  return Object.keys(out).length ? out : undefined;
}
/**
 * Remembers newly accepted key versions and opened document versions, saved once. Never lowers one. Skipped while the document is rolled back.
 * PETTY-438: `fps` holds the fingerprint of each accepted key that has none yet; one already remembered is never replaced.
 */
export async function recordDrawerVersions(keys: ReadonlyMap<string, number>, docs: ReadonlyMap<string, number>, fps: ReadonlyMap<string, { readonly version: number; readonly fp: string }> = new Map()): Promise<void> {
  const higher = [...keys].some(([id, v]) => v > (acceptedKeyVersion(id) ?? 0)) || [...docs].some(([id, v]) => v > (acceptedDocVersion(id) ?? 0)) || [...fps].some(([id, k]) => acceptedKeyFingerprint(id, k.version) === null);
  if (pinsBlocked() || !higher) return;
  await save((doc) => {
    const next = { ...doc };
    const k = raised(doc.drawer_keys, keys);
    if (k) next.drawer_keys = k;
    const d = raised(doc.drawer_docs, docs);
    if (d) next.drawer_docs = d;
    const f = { ...doc.drawer_key_fps };
    for (const [id, key] of fps) if (acceptedKeyFingerprint(id, key.version, doc) === null) f[id] = { ...f[id], [String(key.version)]: key.fp };
    if (Object.keys(f).length) next.drawer_key_fps = f;
    return next;
  });
}

/** PETTY-449: the newest key version of this drawer that someone who left it may still hold; null for a person not known to have left. */
export function leftDrawerAt(drawerId: string, userId: string, doc: UserDocT = state.doc): number | null { return doc.drawer_left?.[drawerId]?.[userId] ?? null; }
/** PETTY-449: someone left this drawer while it had this key version, so its key is owed a replacement. The app does not wait for the server to say so. */
export function rotationOwed(drawerId: string, keyVersion: number, doc: UserDocT = state.doc): boolean {
  return Object.values(doc.drawer_left?.[drawerId] ?? {}).some((v) => v >= keyVersion);
}
/**
 * Whether a drawer key at this version is taken from this person (PETTY-438): only when I confirmed their safety number.
 * PETTY-449: and not when I know they left this drawer and the key is newer than the last one they held, until I
 * confirm them again for it (`confirmPin` with the drawer).
 */
export function confirmedFor(drawerId: string, userId: string, keyVersion: number, doc: UserDocT = state.doc): boolean {
  const left = leftDrawerAt(drawerId, userId, doc);
  return !!doc.pins[userId]?.confirmed_at && (left === null || keyVersion <= left);
}
/** One drawer as the server lists it: who is in it, and the key wraps it holds for me. */
export interface DrawerPeople { readonly id: string; readonly key_version: number; readonly members: readonly string[]; readonly wraps: readonly { readonly key_version: number; readonly sender_id?: string | null | undefined }[] }
/**
 * PETTY-449: compares who the server lists in each drawer with whom this person saw there before. Someone no longer
 * listed left or was removed, and is remembered with the newest key version they may hold: the newest this person had
 * accepted, or a newer one that they wrapped themselves. A key that is newer still, and that someone else wrapped, is
 * taken to be the one that replaced theirs. Returns `doc` itself when nothing changed.
 */
export function membersNoted(doc: UserDocT, meId: string, drawers: readonly DrawerPeople[]): UserDocT {
  let seen = doc.drawer_members;
  let left = doc.drawer_left;
  for (const d of drawers) {
    const before = doc.drawer_members?.[d.id] ?? [];
    const listed = [...new Set(d.members)].filter((id) => id !== meId).sort();
    if (before.length === listed.length && before.every((id, i) => id === listed[i])) continue;
    seen = { ...seen };
    if (listed.length) seen[d.id] = listed; else delete seen[d.id];
    for (const gone of before.filter((id) => !listed.includes(id))) {
      const held = Math.max(acceptedKeyVersion(d.id, doc) ?? 0, ...d.wraps.filter((w) => w.sender_id === gone && w.key_version <= d.key_version).map((w) => w.key_version)) || d.key_version;
      left = { ...left, [d.id]: { ...left?.[d.id], [gone]: Math.max(held, left?.[d.id]?.[gone] ?? 0) } };
    }
  }
  if (seen === doc.drawer_members && left === doc.drawer_left) return doc;
  const next = { ...doc };
  if (seen && Object.keys(seen).length) next.drawer_members = seen; else delete next.drawer_members;
  if (left) next.drawer_left = left;
  return next;
}
/** PETTY-449: `membersNoted`, kept in the user document. In memory at once, so the keys opened next already follow it; a save that fails goes out with the next one. */
export async function noteMembers(drawers: readonly DrawerPeople[]): Promise<void> {
  const a = getAuth();
  if (a.status !== "unlocked" || !pinsReady()) return;
  const meId = a.me.id;
  const mutate = (doc: UserDocT): UserDocT => membersNoted(doc, meId, drawers);
  if (mutate(state.doc) === state.doc) return;
  set({ ...state, doc: mutate(state.doc) });
  await save(mutate);
}
/**
 * PETTY-449: this person removed someone from a drawer that had this key version. Remembered here, so the key is replaced
 * from this account's own memory, on this device or the next. Answers whether that was news to the document.
 */
export async function recordLeft(drawerId: string, userId: string, keyVersion: number): Promise<boolean> {
  const mutate = (doc: UserDocT): UserDocT => ((leftDrawerAt(drawerId, userId, doc) ?? 0) >= keyVersion ? doc : { ...doc, drawer_left: { ...doc.drawer_left, [drawerId]: { ...doc.drawer_left?.[drawerId], [userId]: keyVersion } } });
  if (!pinsReady() || mutate(state.doc) === state.doc) return false;
  set({ ...state, doc: mutate(state.doc) });
  await save(mutate);
  return true;
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

/**
 * The user compared the safety number out of band (or accepted a key change): pin these keys as confirmed.
 * PETTY-449: with `drawerId`, the person also counts as a member of that drawer again, if they were known to have left it.
 * Only where the user acts on that drawer by name: its Members screen and its invite sheet. An invitation card does not
 * say which drawer it is for, so accepting one never does this.
 */
export async function confirmPin(userId: string, keys: { ecdh_pub: string; ecdsa_pub: string; sig_key_id: string }, drawerId?: string): Promise<void> {
  await save((doc) => pinConfirmed(doc, userId, keys, new Date().toISOString(), drawerId));
}
/** `confirmPin` on a document. PETTY-413: a signing key that was confirmed before, and is replaced now, stays in `earlier`. */
export function pinConfirmed(doc: UserDocT, userId: string, keys: { ecdh_pub: string; ecdsa_pub: string; sig_key_id: string }, now: string, drawerId?: string): UserDocT {
  const old = doc.pins[userId];
  const earlier = [...(old?.earlier ?? []), ...(old?.confirmed_at ? [{ ecdsa: old.ecdsa, sig_key_id: old.sig_key_id }] : [])]
    .filter((k, i, all) => k.ecdsa !== keys.ecdsa_pub && all.findIndex((x) => x.ecdsa === k.ecdsa) === i);
  const pin: Pin = { ecdh: keys.ecdh_pub, ecdsa: keys.ecdsa_pub, sig_key_id: keys.sig_key_id, pinned_at: old?.pinned_at ?? now, confirmed_at: now, ...(earlier.length ? { earlier } : {}) };
  const next: UserDocT = { ...doc, pins: { ...doc.pins, [userId]: pin } };
  if (drawerId && leftDrawerAt(drawerId, userId, doc) !== null) {
    const left = { ...doc.drawer_left, [drawerId]: { ...doc.drawer_left?.[drawerId] } };
    delete left[drawerId]![userId];
    if (!Object.keys(left[drawerId]!).length) delete left[drawerId];
    if (Object.keys(left).length) next.drawer_left = left; else delete next.drawer_left;
  }
  return next;
}
/** PETTY-413: every signing key (base64 SPKI) this person pinned for someone, the current one first; null for a person never pinned. */
export function pinnedSigningKeys(userId: string, doc: UserDocT = state.doc): readonly string[] | null {
  const p = doc.pins[userId];
  return p ? [p.ecdsa, ...(p.earlier ?? []).map((k) => k.ecdsa)] : null;
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

/** `pinStatus` for a member of this drawer. PETTY-449: someone I know left it, and who is listed again, counts as not confirmed until I compare again. */
export function memberStatus(drawerId: string, m: Member): PinStatus {
  const st = pinStatus(m);
  return st === "confirmed" && leftDrawerAt(drawerId, m.user_id) !== null ? "unconfirmed" : st;
}

export async function memberSafetyNumber(m: Member): Promise<string> {
  return m.keys ? safetyNumber({ ecdh: m.keys.ecdh_pub, ecdsa: m.keys.ecdsa_pub }) : "";
}
