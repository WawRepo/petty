import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPublicKeys, generateUserKeys, signDelegation, signingKeyId, type SignedDelegationV1 } from "@petty/crypto";

/**
 * PETTY-523: the delegations kept for a start with no network. The server is played by `fetch`, IndexedDB by a map, and the
 * unlocked vault by the session stub. "Offline" is a fetch that never reaches the server, as the browser reports it.
 */
const mem = vi.hoisted(() => ({ idb: new Map<string, unknown>(), auth: { status: "locked" } as unknown }));
vi.mock("./idb.js", () => ({
  idb: {
    get: async (k: string) => mem.idb.get(k),
    set: async (k: string, v: unknown) => { mem.idb.set(k, JSON.parse(JSON.stringify(v))); },
    del: async (k: string) => { mem.idb.delete(k); },
    clear: async () => { mem.idb.clear(); },
    keys: async () => [...mem.idb.keys()],
  },
}));
vi.mock("./session.js", () => ({ getAuth: () => mem.auth }));

import { delegatedKey, delegationsOf, forgetDelegations, withSeenRevocations, type Listed } from "./delegations.js";

const ME = "5b0c6a0e-6f0e-4d7e-9a57-0d6c1f6a2a11";
const OTHER = "6c1d7b1f-7f1f-4e8f-8b68-1e7d2f7b3b22";
const AUTHOR = "7d2e8c20-8020-4f90-9c79-2f8e3a8c4c33";
const T0 = "2026-11-01T10:00:00.000Z";
const BEFORE = "2026-11-02T10:00:00.000Z";
const REVOKED = "2026-11-03T10:00:00.000Z";
const AFTER = "2026-11-04T10:00:00.000Z";

let account: { spki: string; sigKeyId: string; priv: CryptoKey };
let tokenSigKeyId: string;
let delegation: SignedDelegationV1;

/** The server as the test sets it: the author's list, or no network, or a refusal. */
const server = { list: [] as Listed, mode: "up" as "up" | "down" | "refuse", calls: 0 };
function serve(): void {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url !== `/api/users/${AUTHOR}/delegations`) throw new Error(`unexpected request: ${url}`);
    server.calls += 1;
    if (server.mode === "down") throw new TypeError("Failed to fetch");
    if (server.mode === "refuse") return new Response(JSON.stringify({ code: "NotFound" }), { status: 404 });
    return new Response(JSON.stringify({ delegations: server.list }), { status: 200 });
  });
}
const signedIn = (id: string) => { mem.auth = { status: "unlocked", me: { id } }; };
/** A reload: memory is gone, IndexedDB stays. */
const reload = () => forgetDelegations();
/** The account key the reader holds for the author: the one pinned, as accountSpki finds it. */
const held = async (id: string) => (id === account.sigKeyId ? { spki: account.spki, pinned: true } : null);
const tokenKeyAt = (receivedAt: string) => delegatedKey(AUTHOR, tokenSigKeyId, receivedAt, held);

beforeAll(async () => {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  account = { spki: pub.ecdsa, sigKeyId: await signingKeyId(pub.ecdsa), priv: keys.ecdsa.privateKey };
  const tool = await exportPublicKeys(await generateUserKeys());
  delegation = await signDelegation(account.priv, { user_id: AUTHOR, account_sig_key_id: account.sigKeyId, token_ecdsa_pub: tool.ecdsa, created_at: T0, expires_at: null });
  tokenSigKeyId = delegation.token_sig_key_id;
});
beforeEach(() => {
  mem.idb.clear();
  signedIn(ME);
  reload();
  Object.assign(server, { list: [{ delegation, revoked_at: null }], mode: "up", calls: 0 });
  serve();
});
afterEach(() => vi.unstubAllGlobals());

describe("delegations kept for a start with no network", () => {
  it("a tool's entry checks online, and again after a reload with no network, from the list kept for this person", async () => {
    expect((await tokenKeyAt(BEFORE))?.sig_key_id).toBe(tokenSigKeyId);
    expect(mem.idb.get(`cache.delegations.${AUTHOR}`)).toMatchObject({ userId: ME, list: [{ revoked_at: null }] });
    reload();
    server.mode = "down";
    const k = await tokenKeyAt(BEFORE);
    expect(k?.sig_key_id).toBe(tokenSigKeyId);
    expect(k?.pinned).toBe(true);
    expect(server.calls).toBe(2);
  });

  it("with no network and nothing kept, or kept for someone else, a tool's entry does not check", async () => {
    server.mode = "down";
    expect(await tokenKeyAt(BEFORE)).toBeNull();
    server.mode = "up";
    signedIn(OTHER);
    expect(await tokenKeyAt(BEFORE)).not.toBeNull(); // kept for OTHER now
    reload();
    signedIn(ME);
    server.mode = "down";
    expect(await delegationsOf(AUTHOR)).toBeNull();
    expect(await tokenKeyAt(BEFORE)).toBeNull();
  });

  it("a refusal is not 'no network': the list kept is not used, as before", async () => {
    await tokenKeyAt(BEFORE);
    reload();
    server.mode = "refuse";
    expect(await tokenKeyAt(BEFORE)).toBeNull();
  });

  it("a revocation seen once stays, online and offline: a later answer cannot take it back or move it later", async () => {
    server.list = [{ delegation, revoked_at: REVOKED }];
    expect(await tokenKeyAt(BEFORE)).not.toBeNull();
    expect(await tokenKeyAt(AFTER)).toBeNull();
    // the server forgets the revocation
    reload();
    server.list = [{ delegation, revoked_at: null }];
    expect(await tokenKeyAt(AFTER)).toBeNull();
    // or moves it later
    reload();
    server.list = [{ delegation, revoked_at: "2026-11-05T10:00:00.000Z" }];
    expect(await tokenKeyAt(AFTER)).toBeNull();
    expect((await delegationsOf(AUTHOR))?.[0]?.revoked_at).toBe(REVOKED);
    // and with no network, the list kept says the same
    reload();
    server.mode = "down";
    expect(await tokenKeyAt(BEFORE)).not.toBeNull();
    expect(await tokenKeyAt(AFTER)).toBeNull();
  });

  it("an earlier revocation does count, and so does one in a second listing of the same token", async () => {
    server.list = [{ delegation, revoked_at: REVOKED }];
    await delegationsOf(AUTHOR);
    reload();
    server.list = [{ delegation, revoked_at: null }, { delegation, revoked_at: "2026-11-01T12:00:00.000Z" }];
    expect(await tokenKeyAt(BEFORE)).toBeNull();
  });

  it("what is kept decides nothing alone: a changed statement, or a broken copy, does not check", async () => {
    await tokenKeyAt(BEFORE);
    const kept = mem.idb.get(`cache.delegations.${AUTHOR}`) as { userId: string; list: Listed };
    const other = await exportPublicKeys(await generateUserKeys());
    kept.list[0] = { ...kept.list[0]!, delegation: { ...kept.list[0]!.delegation, token_ecdsa_pub: other.ecdsa, token_sig_key_id: await signingKeyId(other.ecdsa) } };
    reload();
    server.mode = "down";
    expect(await delegatedKey(AUTHOR, await signingKeyId(other.ecdsa), BEFORE, held)).toBeNull();
    mem.idb.set(`cache.delegations.${AUTHOR}`, { userId: ME, list: "not a list" });
    expect(await delegationsOf(AUTHOR)).toBeNull();
  });

  it("a key the reader does not hold for the author does not vouch, kept or not", async () => {
    await tokenKeyAt(BEFORE);
    reload();
    server.mode = "down";
    expect(await delegatedKey(AUTHOR, tokenSigKeyId, BEFORE, async () => null)).toBeNull();
  });

  it("asks the server once a minute per author online, and every time while there is no network", async () => {
    await tokenKeyAt(BEFORE);
    await tokenKeyAt(BEFORE);
    expect(server.calls).toBe(1);
    reload();
    server.mode = "down";
    await tokenKeyAt(BEFORE);
    await tokenKeyAt(BEFORE);
    expect(server.calls).toBe(3);
  });
});

describe("withSeenRevocations", () => {
  const row = (revoked_at: string | null): Listed[number] => ({ delegation, revoked_at });
  it("keeps the server's list and takes the earliest revocation for each token", () => {
    expect(withSeenRevocations([row(null)], [])).toEqual([row(null)]);
    expect(withSeenRevocations([row(null)], [row(REVOKED)])).toEqual([row(REVOKED)]);
    expect(withSeenRevocations([row(AFTER)], [row(REVOKED)])).toEqual([row(REVOKED)]);
    expect(withSeenRevocations([row(BEFORE)], [row(REVOKED)])).toEqual([row(BEFORE)]);
    expect(withSeenRevocations([row("not a time")], [row(REVOKED)])).toEqual([row(REVOKED)]);
    expect(withSeenRevocations([], [row(REVOKED)])).toEqual([]);
  });
});
