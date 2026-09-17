import { useEffect, useState } from "react";
import { AccessToken, type AccessToken as AccessTokenT } from "@petty/protocol";
import { patSecret, patToken, sealPatBundle, toB64, unwrapDrawerKey, type PatDrawerKey, type UnlockedKeys } from "@petty/crypto";
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

const tokenId = (): string => toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Drawer keys, extractable, for the drawers in scope. A drawer this device cannot open is skipped. */
async function drawerKeys(scope: readonly string[] | null): Promise<PatDrawerKey[]> {
  const me = getAuth();
  if (me.status !== "unlocked") throw new Error("vault locked");
  const out: PatDrawerKey[] = [];
  for (const v of getDrawers().drawers.values() as Iterable<DrawerView>) {
    if (scope && !scope.includes(v.summary.id)) continue;
    const wrap = [...v.wraps].sort((a, b) => b.key_version - a.key_version)[0];
    if (!wrap) continue;
    const sender = await expectedSender(wrap, v.members);
    if (!("pub" in sender)) continue;
    try {
      const key = await unwrapDrawerKey(wrap, me.keys.ecdhPrivate, { drawer_id: v.summary.id, key_version: wrap.key_version, senderEcdhPublicB64: sender.pub }, { extractable: true });
      out.push({ drawer_id: v.summary.id, key_version: wrap.key_version, key: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", key))) });
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
  const drawers = await drawerKeys(opts.scope);
  const ecdsa = opts.unlocked ? toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", opts.unlocked.ecdsaPrivate))) : undefined;
  const bundle = await sealPatBundle(secret, id, { v: 1, user_id: me.me.id, drawers, ...(ecdsa ? { ecdsa } : {}) });
  const row = AccessToken.parse(
    await api<unknown>("POST", "/me/tokens", {
      token_id: id,
      name: opts.name,
      role: opts.role,
      scope: opts.scope ? [...opts.scope] : null,
      expires_at: opts.expiresAt,
      bundle,
    }),
  );
  return { token: patToken(id, secret), row };
}

export async function listAccessTokens(): Promise<AccessTokenT[]> {
  const r = await api<{ tokens: unknown[] }>("GET", "/me/tokens");
  return r.tokens.map((t) => AccessToken.parse(t));
}

export async function revokeAccessToken(id: string): Promise<void> {
  await api("DELETE", `/me/tokens/${id}`);
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
