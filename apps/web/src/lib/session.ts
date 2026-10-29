import { useSyncExternalStore } from "react";
import type { Me } from "@petty/protocol";
import { OwnKeyMismatch, safetyNumber, sessionKeysFrom, unlockPasskeyVault, unlockVault, zero, type PublicKeys, type UnlockedKeys, type UserKeyPairs } from "@petty/crypto";
import { evaluatePrf } from "./passkey.js";
import { api, ApiError, NetworkError, setSessionGoneHandler } from "./api.js";
import { idb } from "./idb.js";
import { resetDrawers } from "./drawers.js";
import { forgetSelfKey } from "./pins.js";

/** The vault stays unlocked this long after a passphrase entry (spec "Session lock: once a day"). */
export const UNLOCK_HOURS = 24;
const K_UNLOCKED = "session.unlocked";
const K_ME = "session.me";

/** `pub` is the vault's, authenticated when it was opened; a record without it (an earlier build) is not used. */
interface UnlockedRecord { userId: string; ecdhPrivate: CryptoKey; ecdsaPrivate: CryptoKey; pub?: PublicKeys; expiresAt: number; scope?: string }

/**
 * PETTY-396: the account's own public keys are the vault's (its AAD binds them, so only the vault's secret
 * could have made them), never GET /me's. A server that answered with other keys could make this client
 * wrap drawer keys for, and derive the user-document key with, a key of its own. So the two must agree.
 */
const samePub = (a: PublicKeys, b: PublicKeys): boolean => a.ecdh === b.ecdh && a.ecdsa === b.ecdsa;
function checkOwnKeys(me: Me, keys: UnlockedKeys): void {
  if (!samePub(me.pub, keys.pub)) throw new OwnKeyMismatch({ user_id: me.id });
}

/**
 * PETTY-140: the cached unlock belongs to ONE identity-provider session. Clerk mode sets the Clerk
 * session id here before booting; a record made under another session (before a sign-out that a
 * redirect cut short, or by an earlier build) is ignored, so a sign-out always means a locked vault.
 */
let sessionScope: string | undefined;
export function setSessionScope(scope: string | undefined): void { sessionScope = scope; }

export type Auth =
  | { status: "loading" }
  | { status: "anonymous" }
  /** Clerk mode (PETTY-88): signed in with Clerk, no vault yet — the setup screen creates it. */
  | { status: "novault" }
  | { status: "locked"; me: Me }
  | { status: "unlocked"; me: Me; keys: UnlockedKeys; expiresAt: number };

let state: Auth = { status: "loading" };
const listeners = new Set<() => void>();
function set(next: Auth): void { state = next; for (const l of listeners) l(); }

export function useAuth(): Auth {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export function getAuth(): Auth { return state; }

/** The server answered 401 outside a credential form: the session is gone. Local state must not outlive it. */
async function sessionGone(): Promise<void> {
  const s = state;
  if (s.status !== "locked" && s.status !== "unlocked") return;
  await clearAll();
  set({ status: "anonymous" });
}
setSessionGoneHandler(() => { void sessionGone(); });

/** The 24 h vault lock must also fire while the page stays open, not only at the next boot. */
let lockTimer: number | undefined;
function scheduleLock(expiresAt: number): void {
  if (typeof window === "undefined") return;
  window.clearTimeout(lockTimer);
  lockTimer = window.setTimeout(() => { void lockNow(); }, Math.min(2_147_000_000, Math.max(0, expiresAt - Date.now()) + 250));
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const s = state;
    if (s.status === "unlocked" && s.expiresAt <= Date.now()) { void lockNow(); return; }
    // Returning to the foreground: one cheap call. A dead session signs out via the 401 handler; offline is ignored.
    if (s.status === "unlocked" || s.status === "locked") void api("GET", "/me").catch(() => undefined);
  });
}

/**
 * PETTY-405: whether this device keeps the unlocked key handles in IndexedDB, so a reload or a new tab
 * stays unlocked until the 24 h lock. The handles are non-extractable, but IndexedDB is part of the
 * browser profile on disk. Off (a computer that others use), the keys live in this page's memory only.
 * A preference of the device, so a sign-out keeps it.
 */
const K_REMEMBER = "petty.rememberUnlock";
export function rememberUnlock(): boolean { try { return localStorage.getItem(K_REMEMBER) !== "0"; } catch { return true; } }
export function setRememberUnlock(on: boolean): void { try { if (on) localStorage.removeItem(K_REMEMBER); else localStorage.setItem(K_REMEMBER, "0"); } catch { /* ignore */ } }

/** "This browser signed in once and has not signed out": set on sign-in, cleared on sign-out. A visitor without it skips /me (PETTY-133). */
const K_SIGNED = "petty.session";
const markSignedIn = (on: boolean) => { try { if (on) localStorage.setItem(K_SIGNED, "1"); else localStorage.removeItem(K_SIGNED); } catch { /* ignore */ } };
const wasSignedIn = () => { try { return localStorage.getItem(K_SIGNED) === "1"; } catch { return false; } };

/** On app start: who am I, and is the vault still open from a previous visit? `assumeSignedIn` (Clerk mode) skips the local marker check. */
export async function boot(opts: { assumeSignedIn?: boolean } = {}): Promise<void> {
  let me: Me | undefined;
  if (!opts.assumeSignedIn && !wasSignedIn() && !(await idb.get<Me>(K_ME))) { set({ status: "anonymous" }); return; }
  try {
    me = await api<Me>("GET", "/me");
    await idb.set(K_ME, me);
    markSignedIn(true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { await clearAll(); set({ status: "anonymous" }); return; }
    if (e instanceof ApiError && e.status === 404 && e.code === "NoVault") { await clearAll(); set({ status: "novault" }); return; }
    if (e instanceof NetworkError) me = await idb.get<Me>(K_ME); // offline: the cached vault blob (ciphertext) still allows unlocking
    if (!me) { set({ status: "anonymous" }); return; }
  }
  const cached = await idb.get<UnlockedRecord>(K_UNLOCKED);
  // A server whose keys for this account changed since the unlock gets a locked vault: the unlock then says why.
  if (cached && cached.userId === me.id && cached.expiresAt > Date.now() && (cached.scope ?? undefined) === sessionScope && cached.pub && samePub(cached.pub, me.pub)) {
    set({ status: "unlocked", me, keys: { ecdhPrivate: cached.ecdhPrivate, ecdsaPrivate: cached.ecdsaPrivate, pub: cached.pub }, expiresAt: cached.expiresAt });
    scheduleLock(cached.expiresAt);
    return;
  }
  await idb.del(K_UNLOCKED);
  set({ status: "locked", me });
}

/** Custody changed (passphrase change, passkey added/removed): keep the session as it is, remember the new public data. */
export async function updateMe(patch: Partial<Pick<Me, "vault" | "passkeys" | "display_name" | "locale">>): Promise<void> {
  const s = state;
  if (s.status !== "locked" && s.status !== "unlocked") return;
  const me = { ...s.me, ...patch };
  await idb.set(K_ME, me);
  set(s.status === "unlocked" ? { ...s, me } : { status: "locked", me });
}
export const updateVault = (vault: Me["vault"]): Promise<void> => updateMe({ vault });

export async function afterLogin(me: Me): Promise<void> {
  await idb.set(K_ME, me);
  markSignedIn(true);
  set({ status: "locked", me });
}

function openSession(me: Me, keys: UnlockedKeys): Promise<void> {
  checkOwnKeys(me, keys);
  const expiresAt = Date.now() + UNLOCK_HOURS * 3_600_000;
  const record: UnlockedRecord = { userId: me.id, ecdhPrivate: keys.ecdhPrivate, ecdsaPrivate: keys.ecdsaPrivate, pub: keys.pub, expiresAt, ...(sessionScope ? { scope: sessionScope } : {}) };
  set({ status: "unlocked", me, keys, expiresAt });
  scheduleLock(expiresAt);
  return rememberUnlock() ? idb.set(K_UNLOCKED, record) : idb.del(K_UNLOCKED);
}
function signedIn(): Me {
  const s = state;
  if (s.status !== "locked" && s.status !== "unlocked") throw new Error("not signed in");
  return s.me;
}

/** Argon2id + unwrap, then cache the non-extractable handles with an expiry. Throws WrongPassphrase. */
export async function unlock(passphrase: string): Promise<void> {
  const me = signedIn();
  // Only the passphrase wrap is unlocked here (SR-12): the recovery blob has its own flow, and a
  // server that served a different kind would be trying something.
  if (!me.vault || me.vault.kind !== "passphrase") throw new Error("vault kind");
  await openSession(me, await unlockVault(me.vault, passphrase));
}

/**
 * Passkey unlock: PRF from whichever of the account's passkeys the user picks → open that
 * passkey vault → same session as a passphrase unlock. With `hold`, the session is NOT opened
 * yet: the caller gets the non-extractable keys plus an extractable copy (never stored) and an
 * `open()` to call when ready — so the unlock screen can first offer a passkey for THIS device
 * after an unlock through the phone's QR code on a new laptop, before the route guard moves on.
 */
export interface PasskeyUnlock { credential_id: string; extractable: UnlockedKeys | null; open: () => Promise<void> }
export async function unlockWithPasskey(opts: { hold?: boolean } = {}): Promise<PasskeyUnlock> {
  const me = signedIn();
  if (!me.passkeys.length) throw new Error("no passkey");
  const { credential_id, prf } = await evaluatePrf(me.passkeys);
  const pk = me.passkeys.find((p) => p.credential_id === credential_id);
  try {
    if (!pk) throw new Error("unknown passkey");
    const keys = await unlockPasskeyVault(pk.vault, prf);
    checkOwnKeys(me, keys); // before the caller may wrap these keys for another passkey
    const extractable = opts.hold ? await unlockPasskeyVault(pk.vault, prf, { extractable: true }) : null;
    let opened = false;
    const open = async () => { if (!opened) { opened = true; await openSession(signedIn(), keys); } }; // signedIn() again: the caller may have added a passkey meanwhile
    if (!opts.hold) await open();
    return { credential_id, extractable, open };
  } finally { zero(prf); }
}

/** Right after creating the vault: the freshly generated keys open the session without a second prompt (passkey) or a second Argon2id (passphrase). */
export async function unlockWithKeys(keys: UserKeyPairs): Promise<void> {
  await openSession(signedIn(), await sessionKeysFrom(keys));
}

export async function lockNow(): Promise<void> {
  if (typeof window !== "undefined") window.clearTimeout(lockTimer);
  // Locked first (PETTY-326): the store's reset below re-renders the screen still on view, and while the
  // session still said "unlocked" it started a load that then failed on the lock and stayed "loading" —
  // after the next unlock Home showed "Loading…" until a reload.
  const s = state;
  if (s.status === "unlocked") set({ status: "locked", me: s.me });
  resetDrawers();
  forgetSelfKey();
  await idb.del(K_UNLOCKED);
}

let signOutHandler: (() => Promise<void>) | null = null;
/** Clerk mode: signing out is Clerk's; local mode posts /auth/logout. */
export function setSignOutHandler(h: (() => Promise<void>) | null): void { signOutHandler = h; }

export async function signOut(): Promise<void> {
  // Anonymous FIRST: that unmounts the signed-in screens, so nothing reloads drawers (and re-writes
  // the cache) while the store is being wiped underneath it. And the wipe BEFORE the provider's
  // sign-out (PETTY-140): Clerk's signOut navigates away, and a wipe started after it never finishes —
  // the unlocked key handles would survive in IndexedDB and open the vault for the next sign-in.
  set({ status: "anonymous" });
  await clearAll();
  if (signOutHandler) { try { await signOutHandler(); } catch { /* offline: local sign-out still happened */ } }
  else { try { await api("POST", "/auth/logout"); } catch { /* offline: local sign-out still happened */ } }
}

/**
 * Clerk reported no session (signed out elsewhere, or never signed in): drop anything local. Also while
 * still "loading" (PETTY-405): a Clerk session that ended while the app was closed left the cached
 * unlock and the cache in IndexedDB, and the next start never got as far as a signed-in state to wipe them.
 */
export async function toAnonymous(): Promise<void> {
  set({ status: "anonymous" });
  await clearAll();
}

/**
 * Sign-out wipes IndexedDB (SR-8): the ciphertext cache, the outbox, the key handles. Two kinds of
 * record stay, because they hold nothing secret and only catch a server that goes back in time:
 * `head.*`, the pinned log heads (the same for everyone who shares the drawer), and `userdoc.*`, the
 * newest version of each account's user document seen here (PETTY-402). Without the second, one 401
 * and then a 404 on /me/doc read as "no document yet", and every pin was back to first sight (SR-3).
 */
const KEPT = ["head.", "userdoc."];
async function clearAll(): Promise<void> {
  markSignedIn(false);
  resetDrawers();
  forgetSelfKey();
  for (const k of await idb.keys()) if (!KEPT.some((p) => k.startsWith(p))) await idb.del(k);
}

/** From the unlocked vault's keys (PETTY-396): a number from the server's copy could be the server's own key. */
export async function mySafetyNumber(keys: UnlockedKeys): Promise<string> {
  return safetyNumber(keys.pub);
}
