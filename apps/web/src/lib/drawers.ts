/**
 * Client-side data layer. Holds decrypted drawer documents, drawer keys and
 * entry windows IN MEMORY ONLY (CLAUDE.md rule 1). Every write is an operation
 * applied locally, sealed, and sent with the version it was based on; a 409
 * re-fetches, re-applies the operations on the newer document and retries
 * (SPEC-ISSUES B4).
 */
import { useSyncExternalStore } from "react";
import {
  delegationCovers, fromB64, importEcdsaPublic, openDocument, verifyDelegation, openEntryUnverified, openPhoto, sealDocument, sealEntry, sealPhoto, signEntry, toB64, unwrapDrawerKey, verifyEntry,
  createDrawerKey, hashEntry, PettyCryptoError, type EntryOp, type EntryPayloadV1, type RecordIdentity, type Sealed, type SignedEntryV1,
} from "@petty/crypto";
import { applyOps, assertDocumentShape, fold, newDocument, reverseOf, totals, verifyChain, LedgerError, type ChainResult, type DocumentOp, type DrawerDocument, type FoldResult, type LedgerEntry, type Line, type PinnedHead, type Totals, lineCounted } from "@petty/ledger";
import { DocumentHistory, type Bootstrap, type DrawerSummary, type EntryRow, type Invitation, type Member, type SealedRow, type DrawerKeyWrap, type UserDelegations } from "@petty/protocol";
import { api, ApiError } from "./api.js";
import { idb } from "./idb.js";
import { photoUrl } from "./photo.js";
import { getPin, loadPins, pinMembers, pinStatus, pinsBlocked, usePins } from "./pins.js";
import { getAuth } from "./session.js";
import { custodyProof } from "./custody.js";
import { isOnline } from "./net.js";
import { outboxList, outboxPush, type OutboxItem } from "./outbox.js";
import { canonicalJson, utf8, seal, open as openSealed, fromUtf8 } from "@petty/crypto";
import { NetworkError } from "./api.js";
void usePins;

export type DrawerError = "no_key" | "sender_unknown" | "sender_key_changed" | "unwrap_failed" | "decrypt_failed" | "bad_document" | "unknown_schema";
export interface RotationProgress { readonly total: number; readonly done: number }
export interface Transfer { readonly drawer_id: string; readonly from_user_id: string; readonly to_user_id: string }
export type EntryProblemCode = "decrypt_failed" | "signature_invalid" | "author_key_missing";
export interface EntryProblem { readonly line_id: string; readonly entry_id: string; readonly code: EntryProblemCode }
export interface LineHistory { readonly older: readonly LedgerEntry[]; readonly hasMore: boolean }

export interface DrawerView {
  readonly summary: DrawerSummary;
  readonly members: readonly Member[];
  readonly key: CryptoKey | null;
  readonly doc: DrawerDocument | null;
  /** line id → entries since the line's latest Adjust, seq order */
  readonly entries: ReadonlyMap<string, readonly LedgerEntry[]>;
  /** line id → pages before the window (display only, never folded) */
  readonly history: ReadonlyMap<string, LineHistory>;
  /** line id → hash-link check of the window against the pinned head */
  readonly chains: ReadonlyMap<string, ChainResult>;
  /** entries that failed to decrypt or verify; never silently dropped */
  readonly entryProblems: readonly EntryProblem[];
  readonly error: DrawerError | null;
  readonly photo: string | null;   // object URL of decrypted bytes, memory only
  readonly docAuthor: string;
  /** every wrap the server holds for me on this drawer, all key versions */
  readonly wraps: readonly DrawerKeyWrap[];
  /** member ids whose published key differs from what I pinned */
  readonly keyChanged: readonly string[];
  readonly rotation: RotationProgress | null;
  /** entry ids queued in the outbox, not yet accepted by the server */
  readonly pending: ReadonlySet<string>;
  readonly pendingOps: number;
}

export interface DrawersState {
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly drawers: ReadonlyMap<string, DrawerView>;
  readonly order: readonly string[];
  readonly invitations: readonly Invitation[];
  readonly transfers: readonly Transfer[];
  /** true when the last load came from the IndexedDB ciphertext cache (offline) */
  readonly fromCache: boolean;
  /** oldest outbox item age in ms, or null */
  readonly outboxOldest: number | null;
  readonly outboxCount: number;
}

let state: DrawersState = { status: "idle", drawers: new Map(), order: [], invitations: [], transfers: [], fromCache: false, outboxOldest: null, outboxCount: 0 };
const K_BOOT = "cache.bootstrap";
const listeners = new Set<() => void>();
function set(next: DrawersState): void { state = next; for (const l of listeners) l(); }
function patch(id: string, p: Partial<DrawerView>): void {
  const cur = state.drawers.get(id);
  if (!cur) return;
  const drawers = new Map(state.drawers);
  drawers.set(id, { ...cur, ...p });
  set({ ...state, drawers });
}
export function useDrawers(): DrawersState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export function getDrawers(): DrawersState { return state; }

/**
 * A full reload (loadAll) fetches the bootstrap and then opens every drawer, which takes a while. A
 * drawer created or deleted here in the meantime may be missing from, or still in, the bootstrap it
 * fetched, so the reload's final write keeps it as it is now (PETTY-245: a drawer created while a reload
 * ran vanished, and its screen said "Something went wrong"). Each such change takes the next number; a
 * reload keeps whatever changed after the number it started with.
 */
let changeSeq = 0;
const created = new Map<string, number>();
const deleted = new Map<string, number>();

/** Drops every decrypted document, key handle and photo URL from memory (lock, sign-out). */
export function resetDrawers(): void {
  for (const v of state.drawers.values()) if (v.photo) URL.revokeObjectURL(v.photo);
  created.clear();
  deleted.clear();
  set({ status: "idle", drawers: new Map(), order: [], invitations: [], transfers: [], fromCache: false, outboxOldest: null, outboxCount: 0 });
}
export function patchRotation(id: string, rotation: RotationProgress | null): void { patch(id, { rotation }); }

function me() {
  const a = getAuth();
  if (a.status !== "unlocked") throw new Error("vault locked");
  return a;
}

const sealedOf = (r: { nonce: string; ciphertext: string }): Sealed => ({ nonce: fromB64(r.nonce), ciphertext: fromB64(r.ciphertext) });
const docIdentity = (d: DrawerSummary, author: string, keyVersion = d.key_version): RecordIdentity =>
  ({ record_type: "document", record_id: d.id, drawer_id: d.id, line_id: null, author_id: author, key_version: keyVersion, schema_version: 1 });
const photoIdentity = (d: DrawerSummary, author: string, keyVersion = d.key_version): RecordIdentity =>
  ({ record_type: "photo", record_id: d.id, drawer_id: d.id, line_id: null, author_id: author, key_version: keyVersion, schema_version: 1 });
const entryIdentity = (r: EntryRow): RecordIdentity =>
  ({ record_type: "entry", record_id: r.id, drawer_id: r.drawer_id, line_id: r.line_id, author_id: r.author_id, key_version: r.key_version, schema_version: r.schema_version });

/**
 * Which public key the wrap's sender must have (spec "Key verification"): my own
 * key when I stored the wrap, otherwise the key I have PINNED for the sender.
 * First sight of a member pins their published key (trust on first use); after
 * that the pin rules, and a changed key is an error, never a silent re-pin.
 */
export async function expectedSender(wrap: DrawerKeyWrap, members: readonly Member[]): Promise<{ pub: string } | { error: DrawerError }> {
  const a = me();
  if (wrap.sender_id === a.me.id) return { pub: a.me.pub.ecdh };
  if (!wrap.sender_id) return { error: "sender_unknown" };
  const pin = getPin(wrap.sender_id);
  if (pin) return { pub: pin.ecdh };
  const m = members.find((x) => x.user_id === wrap.sender_id);
  if (m?.keys) return { pub: m.keys.ecdh_pub };
  // Not a member any more (left, removed, or deleted account): their published keys are kept for exactly this. First sight → pin.
  try {
    const r = await api<{ keys: Array<{ ecdh_pub: string; ecdsa_pub: string; sig_key_id: string } | null> }>("GET", `/users/${wrap.sender_id}/keys`);
    const k = r.keys.find((x) => x?.ecdh_pub === wrap.sender_ecdh_pub);
    if (k) {
      const { pinMembers: pinList } = await import("./pins.js");
      await pinList([{ user_id: wrap.sender_id, display_name: "?", role: "read", keys: { ...k, created_at: "", retired_at: null } }]).catch(() => undefined);
      return { pub: k.ecdh_pub };
    }
  } catch { /* offline or unknown user */ }
  return { error: "sender_unknown" };
}

async function unwrapVersion(d: DrawerSummary, wraps: readonly DrawerKeyWrap[], members: readonly Member[], version: number): Promise<{ key: CryptoKey } | { error: DrawerError }> {
  const wrap = wraps.find((w) => w.drawer_id === d.id && w.key_version === version);
  if (!wrap) return { error: "no_key" };
  const sender = await expectedSender(wrap, members);
  if ("error" in sender) return sender;
  try {
    return { key: await unwrapDrawerKey(wrap, me().keys.ecdhPrivate, { drawer_id: d.id, key_version: version, senderEcdhPublicB64: sender.pub }) };
  } catch (e) {
    return { error: e instanceof PettyCryptoError && e.code === "SenderKeyMismatch" ? "sender_key_changed" : "unwrap_failed" };
  }
}

/** Keys by version for one drawer: the current one plus, during a rotation, older ones on demand. */
async function keyResolver(d: DrawerSummary, wraps: readonly DrawerKeyWrap[], members: readonly Member[]) {
  const cache = new Map<number, CryptoKey>();
  return async (version: number): Promise<CryptoKey> => {
    const c = cache.get(version);
    if (c) return c;
    const r = await unwrapVersion(d, wraps, members, version);
    if ("error" in r) throw new Error(r.error);
    cache.set(version, r.key);
    return r.key;
  };
}

function errorCode(e: unknown): DrawerError {
  if (e instanceof PettyCryptoError && e.code === "UnknownSchemaVersion") return "unknown_schema";
  if (e instanceof LedgerError) return "bad_document";
  return "decrypt_failed";
}

async function decryptDocument(key: CryptoKey, d: DrawerSummary, row: SealedRow): Promise<DrawerDocument> {
  const doc = await openDocument(key, docIdentity(d, row.author_id, row.key_version), sealedOf(row));
  assertDocumentShape(doc);
  return doc;
}

/** Display names of authors who are no longer members (left, removed, deleted), learned from /users/:id/keys. */
const nameCache = new Map<string, string>();
/** Signing keys by sig_key_id. Current keys come from the member list; retired ones from /users/:id/keys. */
const keyCache = new Map<string, CryptoKey>();
/** One fetch per author per minute, so a log full of token-signed entries does not fetch once per entry. */
const FETCH_TTL_MS = 60_000;
const fetched = new Map<string, { at: number; p: Promise<unknown> }>();
function fetchOnce<T>(url: string): Promise<T> {
  const hit = fetched.get(url);
  if (hit && Date.now() - hit.at < FETCH_TTL_MS) return hit.p as Promise<T>;
  const p = api<T>("GET", url);
  p.catch(() => fetched.delete(url));
  fetched.set(url, { at: Date.now(), p });
  return p;
}

/** The author's ACCOUNT signing key with this id, as base64 SPKI: from the member list, else from every key they ever published. */
async function accountSpki(members: readonly Member[], authorId: string, sigKeyId: string): Promise<string | null> {
  const m = members.find((x) => x.user_id === authorId && x.keys?.sig_key_id === sigKeyId)?.keys?.ecdsa_pub;
  if (m) return m;
  try {
    const r = await fetchOnce<{ display_name: string; keys: Array<{ sig_key_id: string; ecdsa_pub: string } | null> }>(`/users/${authorId}/keys`);
    nameCache.set(authorId, r.display_name);
    return r.keys.find((k) => k?.sig_key_id === sigKeyId)?.ecdsa_pub ?? null;
  } catch { return null; }
}

/**
 * A key an access token signed with (PETTY-184, review NR-4). It counts only when the author's
 * account key signed a delegation for it, and only for entries the server received before the
 * delegation expired or was revoked. The server hands out the delegations but cannot forge one.
 */
async function delegatedKey(members: readonly Member[], authorId: string, sigKeyId: string, receivedAt: string): Promise<CryptoKey | null> {
  let list: UserDelegations["delegations"];
  try { list = (await fetchOnce<UserDelegations>(`/users/${authorId}/delegations`)).delegations; } catch { return null; }
  const hit = list.find((x) => x.delegation.token_sig_key_id === sigKeyId && x.delegation.user_id === authorId);
  if (!hit) return null;
  const spki = await accountSpki(members, authorId, hit.delegation.account_sig_key_id);
  if (!spki) return null;
  try {
    const d = await verifyDelegation(hit.delegation, { user_id: authorId, sig_key_id: hit.delegation.account_sig_key_id, ecdsa_pub: spki });
    if (!delegationCovers(d, receivedAt, hit.revoked_at)) return null;
    return await importEcdsaPublic(d.token_ecdsa_pub);
  } catch { return null; }
}

async function authorKey(members: readonly Member[], authorId: string, sigKeyId: string, receivedAt: string): Promise<CryptoKey | null> {
  const cached = keyCache.get(sigKeyId);
  if (cached) return cached;
  const spki = await accountSpki(members, authorId, sigKeyId);
  if (!spki) return delegatedKey(members, authorId, sigKeyId, receivedAt);
  const k = await importEcdsaPublic(spki);
  keyCache.set(sigKeyId, k);
  return k;
}

/**
 * Open every row; verify each signature against the author's key. A row that
 * fails to open or verify is reported as a problem and left out of the window
 * (a forged or unreadable entry must not move a balance silently).
 */
async function decryptEntries(keyFor: (version: number) => Promise<CryptoKey>, rows: readonly EntryRow[], members: readonly Member[]): Promise<{ byLine: Map<string, LedgerEntry[]>; problems: EntryProblem[] }> {
  const byLine = new Map<string, LedgerEntry[]>();
  const problems: EntryProblem[] = [];
  for (const r of rows) {
    let entry: SignedEntryV1;
    try { entry = await openEntryUnverified(await keyFor(r.key_version), entryIdentity(r), sealedOf(r)); }
    catch { problems.push({ line_id: r.line_id, entry_id: r.id, code: "decrypt_failed" }); continue; }
    const k = await authorKey(members, entry.author_id, entry.sig_key_id, r.received_at);
    if (!k) { problems.push({ line_id: r.line_id, entry_id: r.id, code: "author_key_missing" }); continue; }
    try { await verifyEntry(entry, { author_id: entry.author_id, sig_key_id: entry.sig_key_id, ecdsaPublic: k }); }
    catch { problems.push({ line_id: r.line_id, entry_id: r.id, code: "signature_invalid" }); continue; }
    const list = byLine.get(r.line_id) ?? [];
    list.push({ seq: r.seq, received_at: r.received_at, entry });
    byLine.set(r.line_id, list);
  }
  return { byLine, problems };
}

const headKey = (drawerId: string, lineId: string) => `head.${drawerId}.${lineId}`;

/** Chain check for every line of a drawer against the heads pinned in IndexedDB; pins advance only when the check is clean. */
async function checkChains(drawerId: string, byLine: ReadonlyMap<string, readonly LedgerEntry[]>): Promise<Map<string, ChainResult>> {
  const out = new Map<string, ChainResult>();
  for (const [lineId, entries] of byLine) {
    const pinned = (await idb.get<PinnedHead>(headKey(drawerId, lineId))) ?? null;
    const r = await verifyChain(entries, pinned);
    out.set(lineId, r);
    if (r.status === "ok" && r.head) await idb.set(headKey(drawerId, lineId), r.head);
  }
  return out;
}

/** The user has looked at a broken/truncated line and accepts the log as it is now: pin the current head. */
export async function acknowledgeChain(drawerId: string, lineId: string): Promise<void> {
  const view = state.drawers.get(drawerId);
  const r = view?.chains.get(lineId);
  if (r?.head) await idb.set(headKey(drawerId, lineId), r.head);
  else await idb.del(headKey(drawerId, lineId));
  if (view) {
    const chains = new Map(view.chains);
    const again = await verifyChain(view.entries.get(lineId) ?? [], r?.head ?? null);
    chains.set(lineId, again);
    patch(drawerId, { chains });
  }
}

/** GET /bootstrap, then decrypt everything. A drawer that fails stays listed with an error, never silently dropped. */
let loading: Promise<void> | null = null;
let again: Promise<void> | null = null;
/**
 * Loads, or reloads, every drawer. One load runs at a time (PETTY-245: Home and the place tree each
 * started one, and the slower one overwrote what happened in between). A call while one runs gets one
 * more run after it, since the running one may have fetched before the caller's change; any number of
 * such calls share that one extra run.
 */
export function loadAll(): Promise<void> {
  if (!loading) {
    loading = loadOnce().finally(() => { loading = null; });
    return loading;
  }
  again ??= loading.catch(() => undefined).then(() => { again = null; return loadAll(); });
  return again;
}
/** For screens that load on first sight: reads the live store, so one render's several effects start one load. */
export function loadIfIdle(): void {
  if (state.status === "idle") void loadAll();
}

async function loadOnce(): Promise<void> {
  // Nothing to load for a signed-out or locked vault. Guards the sign-out race (SR-8): the wipe
  // resets this store, the still-mounted home screen sees "idle" and would reload and re-cache.
  if (getAuth().status !== "unlocked") return;
  const since = changeSeq;
  set({ ...state, status: state.status === "ready" ? "ready" : "loading" });
  const meId = me().me.id;
  let boot: Bootstrap;
  let fromCache = false;
  try {
    boot = await api<Bootstrap>("GET", "/bootstrap");
    await idb.set(K_BOOT, { userId: meId, boot }); // ciphertext + metadata only: what the server holds anyway
  } catch (e) {
    const cached = e instanceof NetworkError ? await idb.get<{ userId: string; boot: Bootstrap }>(K_BOOT) : undefined;
    if (!cached || cached.userId !== meId) { set({ ...state, status: "failed" }); return; }
    boot = cached.boot;
    fromCache = true;
  }
  try { await loadPins(); } catch { /* offline or unavailable: existing pins stay in memory */ }
  const outbox = await outboxList(meId);
  const everyone = new Map<string, Member>();
  for (const list of Object.values(boot.members)) for (const m of list) everyone.set(m.user_id, m);
  for (const inv of boot.invitations) if (inv.inviter.keys) everyone.set(inv.inviter.id, { user_id: inv.inviter.id, display_name: inv.inviter.display_name, role: "owner", keys: inv.inviter.keys });
  try { await pinMembers([...everyone.values()]); } catch { /* keep going with what we have */ }
  const drawers = new Map<string, DrawerView>();
  const toRotate: string[] = [];
  const toResume: string[] = [];
  for (const d of boot.drawers) {
    const members = boot.members[d.id] ?? [];
    const prev = state.drawers.get(d.id);
    const wraps = boot.wraps.filter((w) => w.drawer_id === d.id);
    const keyChanged = members.filter((m) => pinStatus(m) === "changed").map((m) => m.user_id);
    const base: DrawerView = { summary: d, members, key: null, doc: null, entries: new Map(), history: new Map(), chains: new Map(), entryProblems: [], error: null, photo: prev?.photo ?? null, docAuthor: boot.documents[d.id]?.author_id ?? d.owner_id, wraps, keyChanged, rotation: prev?.rotation ?? null, pending: new Set(), pendingOps: 0 };
    const k = await unwrapVersion(d, wraps, members, d.key_version);
    if ("error" in k) { drawers.set(d.id, { ...base, error: k.error }); continue; }
    try {
      const row = boot.documents[d.id];
      if (!row) throw new Error("no document");
      const keyFor = await keyResolver(d, wraps, members);
      const doc = await decryptDocument(await keyFor(row.key_version), d, row);
      const rows = boot.entries.filter((e) => e.drawer_id === d.id);
      const { byLine, problems } = await decryptEntries(keyFor, rows, members);
      const chains = await checkChains(d.id, byLine);
      const merged = await mergePending(d, k.key, keyFor, doc, byLine, outbox.filter((o) => o.drawer_id === d.id));
      drawers.set(d.id, { ...base, key: k.key, doc: merged.doc, entries: merged.entries, chains, entryProblems: problems, pending: merged.pending, pendingOps: merged.pendingOps });
      if (d.role !== "read" && !fromCache) {
        if (d.rotation_needed) toRotate.push(d.id);
        else if (row.key_version < d.key_version || rows.some((e) => e.key_version < d.key_version)) toResume.push(d.id);
      }
    } catch (e) {
      drawers.set(d.id, { ...base, key: k.key, error: errorCode(e) });
    }
  }
  const oldest = outbox.length ? Math.max(...outbox.map((o) => Date.now() - Date.parse(o.created_at))) : null;
  // PETTY-245: what was created or deleted here while this ran stays as it is now
  const order = boot.drawers.map((d) => d.id);
  for (const [id, seq] of created) {
    const now = state.drawers.get(id);
    if (seq > since && now && !drawers.has(id)) { drawers.set(id, now); order.push(id); }
  }
  for (const [id, seq] of deleted) if (seq > since && drawers.delete(id)) order.splice(order.indexOf(id), 1);
  set({ status: "ready", drawers, order, invitations: boot.invitations, transfers: boot.transfers, fromCache, outboxOldest: oldest, outboxCount: outbox.length });
  // Anything queued while offline goes out now (idempotent by client id); a reload mid-send just resumes here.
  if (!fromCache && outbox.length) { const sync = await import("./sync.js"); void sync.syncOutbox(); }
  // A removed member means the key must turn (SPEC-ISSUES A7); any writer's client does it, and resumes an unfinished one.
  if (toRotate.length || toResume.length) {
    const rot = await import("./rotation.js");
    for (const id of toRotate) rot.rotateDrawer(id).catch(() => undefined);
    for (const id of toResume) rot.continueRotation(id).catch(() => undefined);
  }
}

/** Queued-but-unsent entries and operations are shown as if they had landed, marked pending. */
async function mergePending(d: DrawerSummary, key: CryptoKey, keyFor: (v: number) => Promise<CryptoKey>, doc: DrawerDocument, byLine: Map<string, LedgerEntry[]>, items: OutboxItem[]) {
  const a = me();
  const pending = new Set<string>();
  let pendingOps = 0;
  let nextDoc = doc;
  for (const item of items) {
    if (item.kind === "entry") {
      try {
        const b = item.body as { id: string; line_id: string; key_version: number; nonce: string; ciphertext: string };
        const entry = await openEntryUnverified(await keyFor(b.key_version), { record_type: "entry", record_id: b.id, drawer_id: d.id, line_id: b.line_id, author_id: a.me.id, key_version: b.key_version, schema_version: 1 }, { nonce: fromB64(b.nonce), ciphertext: fromB64(b.ciphertext) });
        const list = byLine.get(b.line_id) ?? [];
        const seq = (list[list.length - 1]?.seq ?? 0) + 1;
        if (entry.op === "adjust") byLine.set(b.line_id, [{ seq, received_at: item.created_at, entry }]);
        else byLine.set(b.line_id, [...list, { seq, received_at: item.created_at, entry }]);
        pending.add(b.id);
      } catch { /* unreadable queued item: it will fail at send time and be reported */ }
    } else {
      try {
        const bytes = await openSealed(key, { record_type: "document", record_id: item.id, drawer_id: d.id, line_id: null, author_id: a.me.id, key_version: d.key_version, schema_version: 1 }, { nonce: fromB64(item.sealed.nonce), ciphertext: fromB64(item.sealed.ciphertext) });
        nextDoc = applyOps(nextDoc, JSON.parse(fromUtf8(bytes)) as DocumentOp[], { lineHasEntries: (id) => (byLine.get(id)?.length ?? 0) > 0 });
        pendingOps += 1;
      } catch { /* no longer applies: reported at send time */ }
    }
  }
  return { doc: nextDoc, entries: byLine, pending, pendingOps };
}

/** Recompute outbox statistics (after a sync). */
export async function refreshPending(): Promise<void> {
  const outbox = await outboxList(me().me.id);
  set({ ...state, outboxCount: outbox.length, outboxOldest: outbox.length ? Math.max(...outbox.map((o) => Date.now() - Date.parse(o.created_at))) : null });
}

export function useSharingState(): { invitations: readonly Invitation[]; transfers: readonly Transfer[] } {
  return { invitations: state.invitations, transfers: state.transfers };
}

/** Owner wraps the current drawer key for the invitee's PINNED key (SPEC-ISSUES B5) and creates the invitation. */
export async function inviteMember(id: string, invitee: { id: string; keys: { ecdh_pub: string; ecdsa_pub: string; sig_key_id: string } }, role: "write" | "read"): Promise<void> {
  const a = me();
  const view = state.drawers.get(id);
  if (!view) throw new Error("drawer not ready");
  if (pinsBlocked()) throw new Error("PinsRolledBack");
  const pin = getPin(invitee.id);
  if (!pin || pin.ecdh !== invitee.keys.ecdh_pub) throw new Error("KeyNotConfirmed");
  const wrap = view.wraps.find((w) => w.key_version === view.summary.key_version);
  if (!wrap) throw new Error("no wrap");
  const sender = await expectedSender(wrap, view.members);
  if ("error" in sender) throw new Error(sender.error);
  const extractable = await unwrapDrawerKey(wrap, a.keys.ecdhPrivate, { drawer_id: id, key_version: view.summary.key_version, senderEcdhPublicB64: sender.pub }, { extractable: true });
  const { wrapDrawerKey } = await import("@petty/crypto");
  const forInvitee = await wrapDrawerKey(extractable, { ecdhPrivate: a.keys.ecdhPrivate, ecdhPublicB64: a.me.pub.ecdh }, pin.ecdh, id, view.summary.key_version);
  await api("POST", `/drawers/${id}/invitations`, { invitee_id: invitee.id, role, wrap: forInvitee });
}
export async function acceptInvitation(invitationId: string): Promise<void> { await api("POST", `/invitations/${invitationId}/accept`); await loadAll(); }
export async function declineInvitation(invitationId: string): Promise<void> { await api("POST", `/invitations/${invitationId}/decline`); await loadAll(); }
export async function removeMember(id: string, userId: string): Promise<void> { await api("DELETE", `/drawers/${id}/members/${userId}`); await loadAll(); }
export async function leaveDrawer(id: string): Promise<void> { await api("POST", `/drawers/${id}/leave`); await loadAll(); }
export async function offerTransfer(id: string, userId: string): Promise<void> { await api("POST", `/drawers/${id}/transfer`, { to_user_id: userId }); await loadAll(); }
export async function acceptTransfer(id: string): Promise<void> { await api("POST", `/drawers/${id}/transfer/accept`); await loadAll(); }
export async function cancelTransfer(id: string): Promise<void> { await api("DELETE", `/drawers/${id}/transfer`); await loadAll(); }

export function lineFold(view: DrawerView, lineId: string): FoldResult {
  return fold(view.entries.get(lineId) ?? []);
}
export function lineBalance(view: DrawerView, lineId: string): number {
  return lineFold(view, lineId).balance;
}
/** Anything on this drawer that must be shown, not hidden: unreadable entries, broken links, a shorter log, a negative balance. */
export function drawerWarnings(view: DrawerView): { problems: number; chain: "ok" | "broken" | "truncated"; negative: boolean; skipped: number } {
  let chain: "ok" | "broken" | "truncated" = "ok";
  for (const c of view.chains.values()) { if (c.status === "truncated") chain = "truncated"; else if (c.status === "broken" && chain === "ok") chain = "broken"; }
  let negative = false, skipped = 0;
  for (const l of view.doc?.lines ?? []) { if (l.kind === "single") continue; const f = lineFold(view, l.id); if (f.negative) negative = true; skipped += f.skipped.length; }
  return { problems: view.entryProblems.length, chain, negative, skipped };
}

export function homeTotals(excluded: ReadonlySet<string> = new Set(), only: ReadonlySet<string> | null = null): Totals {
  return totals([...state.drawers.values()].filter((v) => !excluded.has(v.summary.id) && (!only || only.has(v.summary.id))).map((v) => ({
    ok: v.error === null && v.doc !== null && v.entryProblems.length === 0,
    // A line switched out of the total (PETTY-64) is left out here too.
    moneyLines: v.doc ? v.doc.lines.flatMap((l) => (l.kind === "money" && lineCounted(l) ? [{ line: l, balance: lineBalance(v, l.id) }] : [])) : [],
  })));
}

export async function createDrawer(name: string, tags: readonly string[] = []): Promise<string> {
  const a = me();
  const id = crypto.randomUUID();
  const { key, selfWrap } = await createDrawerKey({ ecdhPrivate: a.keys.ecdhPrivate, ecdhPublicB64: a.me.pub.ecdh }, id, 1);
  const doc = applyOps(newDocument(name), [{ type: "set_tags", tags }], { lineHasEntries: () => false });
  const summary: DrawerSummary = { id, owner_id: a.me.id, role: "owner", version: 1, key_version: 1, last_write_at: new Date().toISOString(), last_verified_at: null, rotation_needed: false, has_photo: false };
  const sealed = await sealDocument(key, docIdentity(summary, a.me.id), doc);
  const made = await api<DrawerSummary>("POST", "/drawers", { id, document: { key_version: 1, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) }, self_wrap: selfWrap });
  const drawers = new Map(state.drawers);
  drawers.set(id, { summary: made, members: [{ user_id: a.me.id, display_name: a.me.display_name, role: "owner", keys: a.me.keys }], key, doc, entries: new Map(), history: new Map(), chains: new Map(), entryProblems: [], error: null, photo: null, docAuthor: a.me.id, wraps: [{ ...selfWrap, sender_id: a.me.id }], keyChanged: [], rotation: null, pending: new Set(), pendingOps: 0 });
  created.set(id, ++changeSeq);
  set({ ...state, drawers, order: [...state.order, id] });
  return id;
}

function ctxFor(view: DrawerView) {
  return { lineHasEntries: (id: string) => (view.entries.get(id)?.length ?? 0) > 0 };
}

async function refetch(id: string): Promise<DrawerView> {
  const r = await api<{ drawer: DrawerSummary; document: SealedRow }>("GET", `/drawers/${id}`);
  const view = state.drawers.get(id);
  if (!view?.key) throw new Error("no key");
  const doc = await decryptDocument(view.key, r.drawer, r.document);
  patch(id, { summary: r.drawer, doc, docAuthor: r.document.author_id });
  return state.drawers.get(id)!;
}

export class OpsNoLongerApply extends Error { constructor(readonly code: string) { super(code); this.name = "OpsNoLongerApply"; } }

/**
 * Apply operations to the drawer document and save. On a version conflict the
 * newer document is fetched, the same operations are re-applied and the write
 * retried. If an operation no longer applies (line deleted meanwhile) the
 * caller is told with the ledger error code instead of a silent drop.
 */
export async function mutateDocument(id: string, ops: readonly DocumentOp[], opts: { verification?: boolean; forceOnline?: boolean } = {}): Promise<void> {
  const a = me();
  let view = state.drawers.get(id);
  if (!view?.key || !view.doc) throw new Error("drawer not ready");
  const key = view.key;
  /** Offline: apply locally, queue the operations sealed under the drawer key (SPEC-ISSUES B4). */
  const queue = async (): Promise<void> => {
    const v = state.drawers.get(id)!;
    const next = applyOps(v.doc!, ops, ctxFor(v));
    const opId = crypto.randomUUID();
    const sealed = await seal(key, { record_type: "document", record_id: opId, drawer_id: id, line_id: null, author_id: a.me.id, key_version: v.summary.key_version, schema_version: 1 }, utf8(canonicalJson(ops)));
    await outboxPush(a.me.id, { id: opId, kind: "ops", drawer_id: id, created_at: new Date().toISOString(), sealed: { nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) }, verification: opts.verification ?? false });
    patch(id, { doc: next, pendingOps: v.pendingOps + 1 });
    set({ ...state, outboxCount: state.outboxCount + 1, outboxOldest: state.outboxOldest ?? 0 });
  };
  if (!isOnline() && !opts.forceOnline) { await queue(); return; }
  for (let attempt = 0; attempt < 4; attempt++) {
    let next: DrawerDocument;
    try { next = applyOps(view.doc!, ops, ctxFor(view)); } catch (e) { throw new OpsNoLongerApply(e instanceof LedgerError ? e.code : "unknown"); }
    const sealed = await sealDocument(key, docIdentity(view.summary, a.me.id), next);
    try {
      const r = await api<{ version: number; last_write_at: string; last_verified_at: string | null }>("PUT", `/drawers/${id}/document`, {
        base_version: view.summary.version, key_version: view.summary.key_version, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext), verification: opts.verification ?? false,
      });
      patch(id, { doc: next, docAuthor: a.me.id, summary: { ...view.summary, version: r.version, last_write_at: r.last_write_at, last_verified_at: r.last_verified_at } });
      return;
    } catch (e) {
      if (e instanceof NetworkError && !opts.forceOnline) { await queue(); return; }
      if (e instanceof ApiError && e.code === "VersionConflict") { view = await refetch(id); continue; }
      if (e instanceof ApiError && e.code === "KeyVersionMismatch") { await loadAll(); view = state.drawers.get(id); if (!view?.key) throw e; continue; }
      throw e;
    }
  }
  throw new ApiError(409, "VersionConflict");
}

export async function deleteDrawer(id: string): Promise<void> {
  // PETTY-201 (red-team INFO-1): a permanent delete proves key custody, like vault/account changes.
  const a = getAuth();
  if (a.status !== "unlocked") throw new Error("vault locked");
  await api("DELETE", `/drawers/${id}`, { proof: await custodyProof(a.keys.ecdsaPrivate) });
  const drawers = new Map(state.drawers);
  const v = drawers.get(id);
  if (v?.photo) URL.revokeObjectURL(v.photo);
  drawers.delete(id);
  deleted.set(id, ++changeSeq);
  set({ ...state, drawers, order: state.order.filter((x) => x !== id) });
}

/** Document without the line + the line's entries removed by the server, with the same conflict retry. */
export async function deleteLine(id: string, lineId: string): Promise<void> {
  const a = me();
  let view = state.drawers.get(id);
  if (!view?.key || !view.doc) throw new Error("drawer not ready");
  const key = view.key;
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = applyOps(view.doc!, [{ type: "remove_line", line_id: lineId }], ctxFor(view));
    const sealed = await sealDocument(key, docIdentity(view.summary, a.me.id), next);
    try {
      const r = await api<{ version: number; last_write_at: string; last_verified_at: string | null }>("POST", `/drawers/${id}/lines/${lineId}/delete`, {
        document: { base_version: view.summary.version, key_version: view.summary.key_version, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext), verification: false },
      });
      const entries = new Map(view.entries); entries.delete(lineId);
      const chains = new Map(view.chains); chains.delete(lineId);
      await idb.del(headKey(id, lineId));
      patch(id, { doc: next, entries, chains, docAuthor: a.me.id, summary: { ...view.summary, version: r.version, last_write_at: r.last_write_at } });
      return;
    } catch (e) {
      if (e instanceof ApiError && e.code === "VersionConflict") { view = await refetch(id); continue; }
      throw e;
    }
  }
}

/** The line changed between counting and saving: the server refused the Adjust (SPEC-ISSUES B2). */
export class RecountRequired extends Error { constructor() { super("RecountRequired"); this.name = "RecountRequired"; } }
/** The server refused a Reverse (already reversed, before the checkpoint, or an Adjust). */
export class ReverseRefused extends Error { constructor(readonly reason: string) { super("ReverseRefused"); this.name = "ReverseRefused"; } }

/**
 * Sign, seal and append one entry. An Adjust carries the head seq the count was
 * made against; a Reverse carries the id it cancels (amount from `reverseOf`).
 * After the server accepts, the line's chain is re-checked and its head re-pinned.
 */
export async function appendEntry(id: string, line: Line, op: EntryOp, amount: number, opts: { comment?: string; reverses?: string | null; delta_hint?: number | null } = {}): Promise<LedgerEntry> {
  const a = me();
  const view = state.drawers.get(id);
  if (!view?.key) throw new Error("drawer not ready");
  const existing = view.entries.get(line.id) ?? [];
  const last = existing[existing.length - 1];
  const headSeq = last?.seq ?? 0;
  const payload: EntryPayloadV1 = {
    v: 1, id: crypto.randomUUID(), drawer_id: id, line_id: line.id, op, amount,
    exponent: line.kind === "money" ? line.exponent : 0, comment: opts.comment ?? "", logged_at: new Date().toISOString(),
    reverses: op === "reverse" ? (opts.reverses ?? null) : null, prev_hash: last ? await hashEntry(last.entry) : null, delta_hint: op === "adjust" ? (opts.delta_hint ?? null) : null,
    author_id: a.me.id, sig_key_id: a.me.keys.sig_key_id,
  };
  const signed = await signEntry(payload, a.keys.ecdsaPrivate);
  const identity: RecordIdentity = { record_type: "entry", record_id: payload.id, drawer_id: id, line_id: line.id, author_id: a.me.id, key_version: view.summary.key_version, schema_version: 1 };
  const sealed = await sealEntry(view.key, identity, signed);
  const body: Record<string, unknown> = { id: payload.id, line_id: line.id, is_checkpoint: op === "adjust", reverses_entry_id: payload.reverses, key_version: view.summary.key_version, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) };
  if (op === "adjust") body["expected_head_seq"] = headSeq;
  /** Offline: queue the sealed body and show the entry as pending. */
  const queue = async (): Promise<LedgerEntry> => {
    await outboxPush(a.me.id, { id: payload.id, kind: "entry", drawer_id: id, line_id: line.id, created_at: payload.logged_at, body });
    const le: LedgerEntry = { seq: headSeq + 1, received_at: payload.logged_at, entry: signed };
    const v = state.drawers.get(id)!;
    const entries = new Map(v.entries);
    entries.set(line.id, op === "adjust" ? [le] : [...(v.entries.get(line.id) ?? []), le]);
    const pending = new Set(v.pending); pending.add(payload.id);
    patch(id, { entries, pending });
    set({ ...state, outboxCount: state.outboxCount + 1, outboxOldest: state.outboxOldest ?? 0 });
    return le;
  };
  if (!isOnline()) return queue();
  let r: { entry: EntryRow; created: boolean };
  try {
    r = await api<{ entry: EntryRow; created: boolean }>("POST", `/drawers/${id}/entries`, body);
  } catch (e) {
    if (e instanceof NetworkError) return queue();
    if (e instanceof ApiError && e.code === "RecountRequired") { await reloadLine(id, line.id); throw new RecountRequired(); }
    if (e instanceof ApiError && e.code === "ReverseRefused") { await reloadLine(id, line.id); throw new ReverseRefused(String(e.context["reason"] ?? "refused")); }
    throw e;
  }
  const le: LedgerEntry = { seq: r.entry.seq, received_at: r.entry.received_at, entry: signed };
  const nextEntries = op === "adjust" ? [le] : [...existing, le];
  const entries = new Map(view.entries);
  entries.set(line.id, nextEntries);
  const chains = new Map(view.chains);
  const chain = await verifyChain(nextEntries, (await idb.get<PinnedHead>(headKey(id, line.id))) ?? null);
  chains.set(line.id, chain);
  if (chain.status === "ok" && chain.head) await idb.set(headKey(id, line.id), chain.head);
  patch(id, { entries, chains, summary: { ...view.summary, last_write_at: r.entry.received_at } });
  return le;
}

/** What a Reverse of this entry would be, or why it is refused — from the current fold (mirrors the server's rules). */
export function reverseFor(view: DrawerView, lineId: string, entryId: string) {
  const entries = view.entries.get(lineId) ?? [];
  const target = entries.find((e) => e.entry.id === entryId) ?? view.history.get(lineId)?.older.find((e) => e.entry.id === entryId);
  if (!target) return { ok: false as const, code: "before_checkpoint" as const };
  return reverseOf(target, lineFold(view, lineId));
}

/** Newest rows first from the server, cut at the latest Adjust: the window since the checkpoint. Used after a 409 and for a manual refresh. */
export async function reloadLine(id: string, lineId: string): Promise<void> {
  const view = state.drawers.get(id);
  if (!view?.key) return;
  const rows: EntryRow[] = [];
  let before: number | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await api<{ entries: EntryRow[]; has_more: boolean }>("GET", `/drawers/${id}/lines/${lineId}/entries?limit=200${before ? `&before=${before}` : ""}`);
    rows.push(...r.entries);
    const cp = r.entries.findIndex((e) => e.is_checkpoint);
    if (cp >= 0 || !r.has_more || r.entries.length === 0) break;
    before = r.entries[r.entries.length - 1]!.seq;
  }
  const cpIdx = rows.findIndex((e) => e.is_checkpoint);
  const window = (cpIdx >= 0 ? rows.slice(0, cpIdx + 1) : rows).reverse();
  const { byLine, problems } = await decryptEntries(await keyResolver(view.summary, view.wraps, view.members), window, view.members);
  const entries = new Map(view.entries);
  entries.set(lineId, byLine.get(lineId) ?? []);
  const chains = new Map(view.chains);
  chains.set(lineId, await verifyChain(entries.get(lineId) ?? [], (await idb.get<PinnedHead>(headKey(id, lineId))) ?? null));
  const c = chains.get(lineId)!;
  if (c.status === "ok" && c.head) await idb.set(headKey(id, lineId), c.head);
  const history = new Map(view.history); history.delete(lineId);
  patch(id, { entries, chains, history, entryProblems: [...view.entryProblems.filter((p) => p.line_id !== lineId), ...problems] });
}

/** One more page of history before what is loaded. Display only; the balance never uses it. */
export async function loadOlder(id: string, lineId: string): Promise<void> {
  const view = state.drawers.get(id);
  if (!view?.key) return;
  const h = view.history.get(lineId) ?? { older: [], hasMore: true };
  const oldest = h.older[0]?.seq ?? view.entries.get(lineId)?.[0]?.seq;
  if (!h.hasMore || oldest === undefined) { patch(id, { history: new Map(view.history).set(lineId, { older: h.older, hasMore: false }) }); return; }
  const r = await api<{ entries: EntryRow[]; has_more: boolean }>("GET", `/drawers/${id}/lines/${lineId}/entries?limit=50&before=${oldest}`);
  const { byLine, problems } = await decryptEntries(await keyResolver(view.summary, view.wraps, view.members), [...r.entries].reverse(), view.members);
  const history = new Map(view.history);
  history.set(lineId, { older: [...(byLine.get(lineId) ?? []), ...h.older], hasMore: r.has_more });
  patch(id, { history, entryProblems: [...view.entryProblems, ...problems] });
}

export async function loadPhoto(id: string): Promise<void> {
  const view = state.drawers.get(id);
  if (!view?.key || view.photo || !view.summary.has_photo) return;
  const row = await api<SealedRow>("GET", `/drawers/${id}/photo`);
  const bytes = await openPhoto(view.key, photoIdentity(view.summary, row.author_id, row.key_version), sealedOf(row));
  patch(id, { photo: photoUrl(bytes) });
}

export async function setPhoto(id: string, jpeg: Uint8Array): Promise<void> {
  const a = me();
  const view = state.drawers.get(id);
  if (!view?.key) throw new Error("drawer not ready");
  const sealed = await sealPhoto(view.key, photoIdentity(view.summary, a.me.id), jpeg);
  await api("PUT", `/drawers/${id}/photo`, { key_version: view.summary.key_version, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) });
  if (view.photo) URL.revokeObjectURL(view.photo);
  patch(id, { photo: photoUrl(jpeg), summary: { ...view.summary, has_photo: true, last_write_at: new Date().toISOString() } });
}

export async function removePhoto(id: string): Promise<void> {
  const view = state.drawers.get(id);
  await api("DELETE", `/drawers/${id}/photo`);
  if (view?.photo) URL.revokeObjectURL(view.photo);
  if (view) patch(id, { photo: null, summary: { ...view.summary, has_photo: false, last_write_at: new Date().toISOString() } });
}

export function memberName(view: DrawerView, userId: string): string {
  return view.members.find((m) => m.user_id === userId)?.display_name ?? nameCache.get(userId) ?? "?";
}

/** One earlier version of a drawer's document (PETTY-194): the server keeps them 30 days (PETTY-183). */
export interface DocumentVersion {
  readonly id: string;
  readonly replacedAt: string;
  /** true when an access token (a tool) made the change that replaced it */
  readonly byToken: boolean;
  /** null when this device cannot open it (an older drawer key, or damaged) */
  readonly name: string | null;
  readonly lines: number | null;
}

/** Earlier versions, newest first, opened here with the drawer key. Owner only (the server says 403 to others). */
export async function documentHistory(id: string): Promise<DocumentVersion[]> {
  const view = state.drawers.get(id);
  if (!view?.key) throw new Error("drawer not ready");
  const r = DocumentHistory.parse(await api<unknown>("GET", `/drawers/${id}/document/history`));
  const out: DocumentVersion[] = [];
  for (const h of r.history) {
    let name: string | null = null;
    let lines: number | null = null;
    if (h.document.key_version === view.summary.key_version) {
      try {
        const doc = await openDocument(view.key, docIdentity(view.summary, h.document.author_id, h.document.key_version), sealedOf(h.document));
        assertDocumentShape(doc);
        name = doc.name;
        lines = doc.lines.length;
      } catch { /* damaged or not ours: listed, not restorable */ }
    }
    out.push({ id: h.id, replacedAt: h.replaced_at, byToken: h.by_token, name, lines });
  }
  return out;
}

/** Puts an earlier version back, exactly as it was sealed. The current one becomes a version itself. */
export async function restoreDocument(id: string, versionId: string): Promise<void> {
  const view = state.drawers.get(id);
  if (!view) throw new Error("drawer not ready");
  await api("POST", `/drawers/${id}/document/restore`, { history_id: versionId, base_version: view.summary.version });
  await loadAll();
}
