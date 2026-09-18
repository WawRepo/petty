import { useEffect, useState } from "react";
import { AccessToken, type AccessToken as AccessTokenT } from "@petty/protocol";
import { patSecret, patToken, sealPatBundle, sha256, signDelegation, type SignedDelegationV1, toB64, toHex, unwrapDrawerKey, utf8, wrapDrawerKey, type DrawerKeyWrapV1, type PatDrawerKey, type UnlockedKeys } from "@petty/crypto";
import { custodyProof } from "./custody.js";
import { trustedTokens, updateTrustedTokens } from "./pins.js";
import { api } from "./api.js";
import { expectedSender, getDrawers, loadAll, type DrawerView } from "./drawers.js";
import { getAuth } from "./session.js";

/**
 * Access tokens (PETTY-164): the owner hands one of their own tools a copy of the keys it needs.
 * Everything here happens on this device. The server is told the token's id half and is given a
 * sealed bundle it cannot open; the secret half is shown once and then only the tool has it.
 */
export interface NewTokenOptions {
  readonly name: string;
  readonly role: "read" | "write";
  /** null = every drawer I can open */
  readonly scope: readonly string[] | null;
  readonly expiresAt: string | null;
  /** Needed for a writing token: its bundle carries the signing key, so entries are mine. */
  readonly unlocked?: UnlockedKeys;
}

/** A short, stable fingerprint of a token's public key, kept in the sealed user document (PETTY-181). */
export const keyFingerprint = async (pub: string): Promise<string> => toHex(await sha256(utf8(pub)));

const tokenId = (): string => toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Drawer keys, extractable, for the drawers in scope. A drawer this device cannot open is skipped. */
async function openableKeys(scope: readonly string[] | null): Promise<{ drawerId: string; keyVersion: number; key: CryptoKey }[]> {
  const me = getAuth();
  if (me.status !== "unlocked") throw new Error("vault locked");
  const out: { drawerId: string; keyVersion: number; key: CryptoKey }[] = [];
  for (const v of getDrawers().drawers.values() as Iterable<DrawerView>) {
    if (scope && !scope.includes(v.summary.id)) continue;
    const wrap = [...v.wraps].sort((a, b) => b.key_version - a.key_version)[0];
    if (!wrap) continue;
    const sender = await expectedSender(wrap, v.members);
    if (!("pub" in sender)) continue;
    try {
      const key = await unwrapDrawerKey(wrap, me.keys.ecdhPrivate, { drawer_id: v.summary.id, key_version: wrap.key_version, senderEcdhPublicB64: sender.pub }, { extractable: true });
      out.push({ drawerId: v.summary.id, keyVersion: wrap.key_version, key });
    } catch {
      // a drawer whose wrap this device cannot open simply stays out of the bundle
    }
  }
  return out;
}

/** Creates the token. The returned string is shown once and never stored. */
export async function createAccessToken(opts: NewTokenOptions): Promise<{ token: string; row: AccessTokenT }> {
  const me = getAuth();
  if (me.status !== "unlocked") throw new Error("vault locked");
  if (opts.role === "write" && !opts.unlocked) throw new Error("writing token needs the vault");
  const id = tokenId();
  const secret = patSecret();
  const openable = await openableKeys(opts.scope);
  const drawers: PatDrawerKey[] = [];
  for (const d of openable) drawers.push({ drawer_id: d.drawerId, key_version: d.keyVersion, key: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", d.key))) });
  // PETTY-184 (review NR-4): a writing token gets its OWN signing key, never the account key. The
  // account key signs a delegation for it, which readers check before they trust an entry it signed.
  let signing: { ecdsa: string; sig_key_id: string; body: { ecdsa_pub: string; delegation: SignedDelegationV1 } } | undefined;
  if (opts.role === "write") {
    const sig = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ecdsaPub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", sig.publicKey)));
    const delegation = await signDelegation(me.keys.ecdsaPrivate, {
      user_id: me.me.id,
      account_sig_key_id: me.me.keys.sig_key_id,
      token_ecdsa_pub: ecdsaPub,
      created_at: new Date().toISOString(),
      expires_at: opts.expiresAt,
    });
    signing = { ecdsa: toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", sig.privateKey))), sig_key_id: delegation.token_sig_key_id, body: { ecdsa_pub: ecdsaPub, delegation } };
  }
  // PETTY-169: the token's own ECDH pair. The public half goes to the server, so a drawer made later
  // can be wrapped for this token the way it is wrapped for a person.
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  const ecdh = toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const ecdhPub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const bundle = await sealPatBundle(secret, id, { v: 1, user_id: me.me.id, drawers, ecdh, ...(signing ? { ecdsa: signing.ecdsa, sig_key_id: signing.sig_key_id } : {}) });
  const row = AccessToken.parse(
    await api<unknown>("POST", "/me/tokens", {
      token_id: id,
      ecdh_pub: ecdhPub,
      name: opts.name,
      role: opts.role,
      scope: opts.scope ? [...opts.scope] : null,
      expires_at: opts.expiresAt,
      bundle,
      proof: await custodyProof(me.keys.ecdsaPrivate),
      ...(signing ? { signing: signing.body } : {}),
    }),
  );
  // PETTY-181: record the token in the sealed user document BEFORE any key is wrapped to it. Only
  // tokens recorded there ever receive wraps; the server cannot add one or swap its key.
  const record = { id: row.id, pub_fp: await keyFingerprint(ecdhPub), scope: opts.scope ? [...opts.scope] : null, expires_at: opts.expiresAt };
  try {
    await updateTrustedTokens((list) => [...list.filter((t) => t.id !== row.id), record]);
  } catch (e) {
    await revokeAccessToken(row.id).catch(() => undefined);
    throw e;
  }
  // give the new token its wraps at once, so it sees today's drawers through the same path as later ones
  await postWraps(row.id, ecdhPub, openable).catch(() => undefined);
  return { token: patToken(id, secret), row };
}

/**
 * Wraps for one token (PETTY-169). Each drawer key is wrapped from the owner's ECDH private key to
 * the token's public key, bound to the drawer and its key version, exactly as for a person.
 */
async function postWraps(tokenId: string, tokenEcdhPub: string, keys: readonly { drawerId: string; keyVersion: number; key: CryptoKey }[]): Promise<number> {
  const me = getAuth();
  if (me.status !== "unlocked" || keys.length === 0) return 0;
  const sender = { ecdhPrivate: me.keys.ecdhPrivate, ecdhPublicB64: me.me.pub.ecdh };
  const wraps: { drawer_id: string; key_version: number; wrap: DrawerKeyWrapV1 }[] = [];
  for (const k of keys) {
    wraps.push({ drawer_id: k.drawerId, key_version: k.keyVersion, wrap: await wrapDrawerKey(k.key, sender, tokenEcdhPub, k.drawerId, k.keyVersion) });
  }
  await api("POST", `/me/tokens/${tokenId}/keys`, { keys: wraps });
  return wraps.length;
}

/**
 * Gives every live token the drawers it is missing: a drawer made or shared after the token, or a
 * drawer whose key was rotated. Runs quietly after the app has loaded, and does nothing when there
 * is nothing to add. A token made before PETTY-169 has no public key and is left alone.
 */
let synced = false;
/** Once per session is enough: new drawers made later in this session wrap themselves on the next start. */
export async function syncTokenWrapsOnce(): Promise<void> {
  if (synced) return;
  synced = true;
  await syncTokenWraps().catch(() => undefined);
}

export async function syncTokenWraps(): Promise<number> {
  const me = getAuth();
  if (me.status !== "unlocked") return 0;
  let added = 0;
  const trusted = trustedTokens();
  const now = Date.now();
  const tokens = await listAccessTokens();
  for (const token of tokens) {
    if (!token.ecdh_pub) continue;
    // PETTY-181 (security review NR-1): wrap only to a token this person made, with the very key they
    // made it with, that has not expired. The scope comes from their own record, not from the server.
    const mine = trusted.find((t) => t.id === token.id);
    if (!mine || mine.pub_fp !== (await keyFingerprint(token.ecdh_pub))) continue;
    if (mine.expires_at && Date.parse(mine.expires_at) <= now) continue;
    const have = (await api<{ keys: { drawer_id: string; key_version: number }[] }>("GET", `/me/tokens/${token.id}/keys`)).keys;
    const held = new Set(have.map((k) => `${k.drawer_id}:${k.key_version}`));
    const openable = await openableKeys(mine.scope);
    const missing = openable.filter((k) => !held.has(`${k.drawerId}:${k.keyVersion}`));
    if (missing.length) added += await postWraps(token.id, token.ecdh_pub, missing);
  }
  return added;
}

export async function listAccessTokens(): Promise<AccessTokenT[]> {
  const r = await api<{ tokens: unknown[] }>("GET", "/me/tokens");
  return r.tokens.map((t) => AccessToken.parse(t));
}

export async function revokeAccessToken(id: string): Promise<void> {
  await api("DELETE", `/me/tokens/${id}`);
  if (trustedTokens().some((t) => t.id === id)) await updateTrustedTokens((list) => list.filter((t) => t.id !== id)).catch(() => undefined);
}

/** The list, loaded when the section opens. Drawers are loaded too: their keys go into a new token. */
export function useAccessTokens(open: boolean): { tokens: AccessTokenT[]; reload: () => void } {
  const [tokens, setTokens] = useState<AccessTokenT[]>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!open) return;
    if (getDrawers().status === "idle") void loadAll();
    void listAccessTokens().then(setTokens).catch(() => setTokens([]));
  }, [open, nonce]);
  return { tokens, reload: () => setNonce((n) => n + 1) };
}
