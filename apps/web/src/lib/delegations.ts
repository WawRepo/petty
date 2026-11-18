/**
 * Signing delegations (PETTY-184): an account key's signed statement that an access token's own key writes for that
 * person. An entry a tool wrote is checked against it (drawers.ts, authorKey).
 *
 * PETTY-523: the web app keeps each author's list with the rest of its offline copy (`cache.*`, wiped at sign-out), so
 * a start with no network checks a tool's entries as an online start does. What it keeps decides nothing by itself:
 * - a delegation counts only when it verifies against a key this person holds for the author, as online;
 * - the revocation time, like the time the server received an entry, is the server's word, online and offline. A
 *   revocation this browser saw stays: a later answer cannot take it back or move it later, and the list kept for
 *   offline carries it. So a revoked token's later entries stay out of the balance after a reload with no network.
 */
import { delegationCovers, importEcdsaPublic, verifyDelegation } from "@petty/crypto";
import { UserDelegations } from "@petty/protocol";
import { api, NetworkError } from "./api.js";
import { idb } from "./idb.js";
import { getAuth } from "./session.js";

export type Listed = UserDelegations["delegations"];
/** What is kept per author: the list as last answered, with the revocations seen, for the person signed in then. */
interface Kept { readonly userId: string; readonly list: Listed }
const keptKey = (authorId: string) => `cache.delegations.${authorId}`;

/** One fetch per author per minute, so a log full of a tool's entries does not fetch once per entry. */
const FETCH_TTL_MS = 60_000;
const fetched = new Map<string, { at: number; p: Promise<{ list: Listed | null; fresh: boolean }> }>();
/** Lock and sign-out: what was fetched is fetched again. */
export function forgetDelegations(): void { fetched.clear(); }

/** One token's key, whoever lists it: a revocation seen for it counts for every listing of it. */
const tokenOf = (x: Listed[number]) => `${x.delegation.user_id} ${x.delegation.token_sig_key_id}`;
const time = (s: string) => Date.parse(s);
function earlier(a: string | null, b: string | null): string | null {
  if (a === null || Number.isNaN(time(a))) return b;
  if (b === null || Number.isNaN(time(b))) return a;
  return time(b) < time(a) ? b : a;
}

/** The server's list, where each token's revocation is the earliest one this browser saw for it, in this answer or before. */
export function withSeenRevocations(fresh: Listed, seen: Listed): Listed {
  const revoked = new Map<string, string | null>();
  for (const x of [...seen, ...fresh]) revoked.set(tokenOf(x), earlier(revoked.get(tokenOf(x)) ?? null, x.revoked_at));
  return fresh.map((x) => {
    const r = revoked.get(tokenOf(x)) ?? null;
    return r === x.revoked_at ? x : { ...x, revoked_at: r };
  });
}

async function kept(userId: string, authorId: string): Promise<Listed | null> {
  const k = await idb.get<Kept>(keptKey(authorId));
  if (!k || k.userId !== userId) return null;
  const parsed = UserDelegations.shape.delegations.safeParse(k.list);
  return parsed.success ? parsed.data : null;
}

async function load(userId: string | null, authorId: string): Promise<{ list: Listed | null; fresh: boolean }> {
  let fresh: Listed;
  try {
    fresh = UserDelegations.parse(await api<unknown>("GET", `/users/${authorId}/delegations`)).delegations;
  } catch (e) {
    // only no network falls back to the list kept: a refusal or a malformed answer counts as no list, as before
    return { list: e instanceof NetworkError && userId !== null ? await kept(userId, authorId) : null, fresh: false };
  }
  if (userId === null) return { list: fresh, fresh: true };
  const list = withSeenRevocations(fresh, (await kept(userId, authorId)) ?? []);
  await idb.set(keptKey(authorId), { userId, list } satisfies Kept); // signed statements and times only: nothing secret
  return { list, fresh: true };
}

/** Every delegation the author made, as the server lists them now, or as kept from the last answer when there is no network. */
export async function delegationsOf(authorId: string): Promise<Listed | null> {
  const a = getAuth();
  const userId = a.status === "unlocked" ? a.me.id : null;
  const memo = `${userId ?? ""} ${authorId}`;
  const hit = fetched.get(memo);
  if (hit && Date.now() - hit.at < FETCH_TTL_MS) return (await hit.p).list;
  const p = load(userId, authorId);
  fetched.set(memo, { at: Date.now(), p });
  const r = await p;
  // an answer from the list kept is not held for a minute: the next entry asks again, and the network may be back
  if (!r.fresh && fetched.get(memo)?.p === p) fetched.delete(memo);
  return r.list;
}

/**
 * A key an access token signed with (PETTY-184, review NR-4). It counts only when the author's account key signed a
 * delegation for it, and only for entries the server received before the delegation expired or was revoked. The
 * server hands out the delegations but cannot forge one. `account` finds the account key that vouches, by the same
 * rule as an entry's own key (PETTY-413, drawers.ts accountSpki).
 */
export async function delegatedKey(
  authorId: string, sigKeyId: string, receivedAt: string,
  account: (accountSigKeyId: string) => Promise<{ spki: string; pinned: boolean } | null>,
): Promise<{ key: CryptoKey; sig_key_id: string; pinned: boolean } | null> {
  const list = await delegationsOf(authorId);
  const hit = list?.find((x) => x.delegation.token_sig_key_id === sigKeyId && x.delegation.user_id === authorId);
  if (!hit) return null;
  const vouch = await account(hit.delegation.account_sig_key_id);
  if (!vouch) return null;
  try {
    const d = await verifyDelegation(hit.delegation, { user_id: authorId, sig_key_id: hit.delegation.account_sig_key_id, ecdsa_pub: vouch.spki });
    if (!delegationCovers(d, receivedAt, hit.revoked_at)) return null;
    return { key: await importEcdsaPublic(d.token_ecdsa_pub), sig_key_id: d.token_sig_key_id, pinned: vouch.pinned };
  } catch { return null; }
}
