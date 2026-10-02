import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromB64, openDocument, openPatBundle, patSecret, patToken, sealPatBundle, splitPatToken, toB64, wrapDrawerKey } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import { buildApp } from "../src/app.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * Access tokens (PETTY-164): the owner's own tools. The server holds the id half and a bundle
 * it cannot open; the secret half never arrives here.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
let A: Client, B: Client;

const tokenId = () => toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");

beforeAll(async () => {
  await app.ready();
  const mk = async (n: string) => new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }));
  [A, B] = await Promise.all([mk("pat-a"), mk("pat-b")]);
  for (const c of [A, B]) expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);

afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

async function drawer(client: Client, name: string) {
  const line = crypto.randomUUID();
  const doc = applyOp(newDocument(name), { type: "add_line", line: { id: line, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
  const { id, key, res } = await client.createDrawer(name, doc);
  expect(res.statusCode).toBe(201);
  return { id, key, line };
}

/** Makes a token the way the web app does: the client seals the bundle, the server sees the id only. */
async function makeToken(client: Client, opts: { role: "read" | "write"; scope?: string[] | null; drawers?: { drawer_id: string; key_version: number; key: string }[]; expires_at?: string | null } = { role: "read" }) {
  const secret = patSecret();
  const id = tokenId();
  const signing = opts.role === "write" ? await client.tokenSigning(opts.expires_at ?? null) : null;
  const bundle = await sealPatBundle(secret, id, { v: 1, user_id: client.id, drawers: opts.drawers ?? [], ...(signing ? signing.bundle : {}) });
  const res = await client.call("POST", "/me/tokens", {
    token_id: id,
    name: "Assistant",
    role: opts.role,
    scope: opts.scope ?? null,
    expires_at: opts.expires_at ?? null,
    bundle,
    proof: await client.proof(),
    ...(signing ? { signing: signing.body } : {}),
  });
  return { res, token: patToken(id, secret), secret, id, signing };
}

/** A tool: it holds the token string and sends only the id half. */
const tool = (token: string) => {
  const id = token.split(".")[0]!;
  return (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${id}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
};

describe("access tokens (PETTY-164)", () => {
  it("the token opens its own bundle; the server never sees the secret half", async () => {
    const d = await drawer(A, "Kitchen");
    const raw = await A.unwrap((await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === d.id), A.user.pub.ecdh, true);
    const keyB64 = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", raw)));
    const made = await makeToken(A, { role: "read", drawers: [{ drawer_id: d.id, key_version: 1, key: keyB64 }] });
    expect(made.res.statusCode).toBe(201);

    const self = await tool(made.token)("GET", "/me/token");
    expect(self.statusCode).toBe(200);
    expect(self.json().user_id).toBe(A.id);
    const split = splitPatToken(made.token);
    const opened = await openPatBundle(split.secret, split.tokenId, A.id, self.json().bundle);
    expect(opened.drawers[0]!.key).toBe(keyB64);

    // the stored row holds no secret and no drawer key in the clear
    const { rows } = await apiPool.query<{ ciphertext: string; hash: string }>(
      "select bundle_ciphertext as ciphertext, encode(token_hash, 'hex') as hash from access_tokens where user_id = $1",
      [A.id],
    );
    expect(rows[0]!.ciphertext).not.toContain(keyB64);
    expect(made.token).not.toContain(rows[0]!.hash);
  });

  it("a read token reads its drawer but cannot append; a write token can", async () => {
    const d = await drawer(A, "Shed");
    const read = await makeToken(A, { role: "read" });
    const write = await makeToken(A, { role: "write" });
    expect((await tool(read.token)("GET", `/drawers/${d.id}`)).statusCode).toBe(200);
    const entry = { id: crypto.randomUUID(), line_id: d.line, key_version: 1, schema_version: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", sig: "AAAA", hash: "AAAA", prev_hash: null };
    expect((await tool(read.token)("POST", `/drawers/${d.id}/entries`, entry)).statusCode).toBe(403);
    // the write token gets past the permission check and fails later, on the payload itself
    expect((await tool(write.token)("POST", `/drawers/${d.id}/entries`, entry)).statusCode).not.toBe(403);
  });

  it("a write token may replace a drawer document in its scope; a read token may not (PETTY-175)", async () => {
    const d = await drawer(A, "Pantry");
    const read = await makeToken(A, { role: "read" });
    const write = await makeToken(A, { role: "write", scope: [d.id] });
    const other = await drawer(A, "Elsewhere");
    const got = (await A.call("GET", `/drawers/${d.id}`)).json();
    const body = { base_version: got.drawer.version, key_version: 1, schema_version: 1, nonce: got.document.nonce, ciphertext: got.document.ciphertext, verification: false };
    expect((await tool(read.token)("PUT", `/drawers/${d.id}/document`, body)).statusCode).toBe(403);
    expect((await tool(write.token)("PUT", `/drawers/${d.id}/document`, body)).statusCode).toBe(200);
    expect((await tool(write.token)("PUT", `/drawers/${other.id}/document`, body)).statusCode).toBe(403);
  });

  it("a junk document from a token can be undone by the owner, and a token cannot mark a count (PETTY-183)", async () => {
    const d = await drawer(A, "Undo me");
    const write = tool((await makeToken(A, { role: "write", scope: [d.id] })).token);
    const open = async () => {
      const got = (await A.call("GET", `/drawers/${d.id}`)).json();
      const doc = got.document;
      const identity = { record_type: "document" as const, record_id: d.id, drawer_id: d.id, line_id: null, author_id: doc.author_id, key_version: doc.key_version, schema_version: doc.schema_version };
      return { version: got.drawer.version as number, doc: await openDocument(d.key, identity, { nonce: fromB64(doc.nonce), ciphertext: fromB64(doc.ciphertext) }).catch(() => null) };
    };
    const before = await open();
    expect((before.doc as { name: string }).name).toBe("Undo me");

    const junk = { base_version: before.version, key_version: 1, schema_version: 1, nonce: toB64(crypto.getRandomValues(new Uint8Array(12))), ciphertext: toB64(crypto.getRandomValues(new Uint8Array(40))) };
    expect((await write("PUT", `/drawers/${d.id}/document`, { ...junk, verification: true })).statusCode).toBe(403);
    expect((await write("PUT", `/drawers/${d.id}/document`, { ...junk, verification: false })).statusCode).toBe(200);
    const broken = await open();
    expect(broken.doc).toBeNull();

    // the token cannot see or use history; only the owner can
    expect((await write("GET", `/drawers/${d.id}/document/history`)).statusCode).toBe(403);
    const hist = await A.call("GET", `/drawers/${d.id}/document/history`);
    expect(hist.statusCode).toBe(200);
    const [last] = hist.json().history as { id: string; version: number; by_token: boolean }[];
    expect(last!.by_token).toBe(true);
    expect(last!.version).toBe(before.version);
    expect([403, 404]).toContain((await B.call("GET", `/drawers/${d.id}/document/history`)).statusCode);
    expect((await write("POST", `/drawers/${d.id}/document/restore`, { history_id: last!.id, base_version: broken.version })).statusCode).toBe(403);

    const restored = await A.call("POST", `/drawers/${d.id}/document/restore`, { history_id: last!.id, base_version: broken.version });
    expect(restored.statusCode).toBe(200);
    const after = await open();
    expect(after.doc).toEqual(before.doc);
    // the junk is itself kept, so a wrong restore can be undone too
    expect((await A.call("GET", `/drawers/${d.id}/document/history`)).json().history).toHaveLength(2);
  });

  it("a scoped token cannot touch a drawer outside its scope", async () => {
    const inside = await drawer(A, "Inside");
    const outside = await drawer(A, "Outside");
    const made = await makeToken(A, { role: "read", scope: [inside.id] });
    expect(made.res.statusCode).toBe(201);
    const t = made;
    expect((await tool(t.token)("GET", `/drawers/${inside.id}`)).statusCode).toBe(200);
    expect((await tool(t.token)("GET", `/drawers/${outside.id}`)).statusCode).toBe(403);
  });

  it("a token loads only its own start-up data, never the vault (PETTY-182)", async () => {
    const inside = await drawer(A, "Scoped in");
    await drawer(A, "Scoped out");
    const t = tool((await makeToken(A, { role: "read", scope: [inside.id] })).token);
    expect((await t("GET", "/bootstrap")).statusCode).toBe(403);
    const res = await t("GET", "/me/token/bootstrap");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["authors", "documents", "drawers", "entries", "sig_key_id", "user_id"]);
    expect(body.drawers.map((d: { id: string }) => d.id)).toEqual([inside.id]);
    expect(Object.keys(body.documents)).toEqual([inside.id]);
    expect(body.sig_key_id).toBeTruthy();
    const all = (await tool((await makeToken(A, { role: "read" })).token)("GET", "/me/token/bootstrap")).json();
    expect(all.drawers.length).toBeGreaterThan(1);
    expect(JSON.stringify(all)).not.toMatch(/vault|passkey|wraps|recovery/);
  });

  it("a writing token signs with its own key, vouched for by the account key (PETTY-184)", async () => {
    const d = await drawer(A, "Delegated");
    const entry = { id: crypto.randomUUID(), line_id: d.line, key_version: 1, schema_version: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", sig: "AAAA", hash: "AAAA", prev_hash: null };
    const base = async () => {
      const secret = patSecret();
      const id = tokenId();
      return { token_id: id, name: "w", role: "write", scope: null, expires_at: null, bundle: await sealPatBundle(secret, id, { v: 1, user_id: A.id, drawers: [] }), proof: await A.proof() };
    };
    // no signing key, or a delegation the account key did not sign, is refused
    expect((await A.call("POST", "/me/tokens", await base())).json().code).toBe("SigningKeyRequired");
    const forged = await B.tokenSigning();
    expect((await A.call("POST", "/me/tokens", { ...(await base()), signing: forged.body })).statusCode).toBe(400);
    const mine = await A.tokenSigning();
    expect((await A.call("POST", "/me/tokens", { ...(await base()), signing: { ...mine.body, ecdsa_pub: forged.body.ecdsa_pub } })).json().code).toBe("DelegationMismatch");
    expect((await A.call("POST", "/me/tokens", { ...(await base()), expires_at: "2099-01-01T00:00:00.000Z", signing: mine.body })).json().code).toBe("DelegationMismatch");

    // a good one: the delegation is published for readers, revocation is visible
    const made = await makeToken(A, { role: "write" });
    expect(made.res.statusCode).toBe(201);
    const list = async () => (await A.call("GET", `/users/${A.id}/delegations`)).json().delegations as { delegation: { token_sig_key_id: string }; revoked_at: string | null }[];
    const pub = (await list()).find((x) => x.delegation.token_sig_key_id === made.signing!.bundle.sig_key_id);
    expect(pub?.revoked_at).toBeNull();
    expect((await B.call("GET", `/users/${A.id}/delegations`)).statusCode).toBe(200);
    expect((await tool(made.token)("GET", `/users/${A.id}/delegations`)).statusCode).toBe(403);

    // the token key is not the account key: a custody proof signed with it fails
    const byToken = await A.proof(made.signing!.pair.privateKey);
    expect((await A.call("POST", "/me/tokens", { ...(await base()), proof: byToken, signing: (await A.tokenSigning()).body })).statusCode).toBe(403);

    // a writing token from before PETTY-184 (no own key) may still read but no longer write
    const old = await makeToken(A, { role: "write" });
    await apiPool.query("update access_tokens set sig_key_id = null, ecdsa_pub = null, delegation = null where id = $1", [old.res.json().id]);
    expect((await tool(old.token)("GET", `/drawers/${d.id}`)).statusCode).toBe(200);
    const refused = await tool(old.token)("POST", `/drawers/${d.id}/entries`, entry);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("TokenNeedsRenewal");

    expect((await A.call("DELETE", `/me/tokens/${made.res.json().id}`)).statusCode).toBe(204);
    expect((await list()).find((x) => x.delegation.token_sig_key_id === made.signing!.bundle.sig_key_id)?.revoked_at).toBeTruthy();
  });

  it("PETTY-193 (NR-13): a malformed id is a 404, never a 500", async () => {
    const d = await drawer(A, "Ids");
    for (const url of ["/drawers/not-a-uuid", `/drawers/${d.id}/lines/nope/entries`, "/users/123/keys", "/users/x/delegations", "/invitations/zzz/accept", "/me/tokens/abc/keys"]) {
      const method = url.endsWith("/accept") ? "POST" : "GET";
      const res = await A.call(method, url, method === "POST" ? {} : undefined);
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("a scope must be drawers the owner is a member of", async () => {
    const theirs = await drawer(B, "Theirs");
    const made = await makeToken(A, { role: "read", scope: [theirs.id] });
    expect(made.res.statusCode).toBe(400);
  });

  it("a token cannot touch the vault, the account, sharing, admin or other tokens", async () => {
    const d = await drawer(A, "Safe");
    const t = await makeToken(A, { role: "write" });
    const call = tool(t.token);
    for (const [method, url] of [
      ["GET", "/me"],
      ["GET", "/me/doc"],
      ["GET", "/me/recovery-vault"],
      ["POST", "/me/custody-challenge"],
      ["GET", "/me/delete"],
      ["GET", "/me/tokens"],
      ["POST", "/join-links"],
      ["GET", "/admin/users"],
      ["GET", `/drawers/${d.id}/members`],
      ["GET", `/drawers/${d.id}/export`],
      ["POST", "/drawers"],
    ] as const) {
      const res = await call(method, url, method === "POST" ? {} : undefined);
      expect([403, 404], `${method} ${url} answered ${res.statusCode}`).toContain(res.statusCode);
    }
    // and it cannot make another token
    expect((await call("POST", "/me/tokens", { token_id: tokenId(), name: "x", role: "read", scope: null, expires_at: null, bundle: { nonce: "AAAA", ciphertext: "AAAA" } })).statusCode).toBe(403);
  });

  it("revoked and expired tokens are refused, and the list shows what is left", async () => {
    const d = await drawer(A, "Attic");
    const live = await makeToken(A, { role: "read" });
    const doomed = await makeToken(A, { role: "read" });
    expect((await A.call("DELETE", `/me/tokens/${doomed.res.json().id}`)).statusCode).toBe(204);
    expect((await tool(doomed.token)("GET", `/drawers/${d.id}`)).statusCode).toBe(401);
    expect((await tool(live.token)("GET", `/drawers/${d.id}`)).statusCode).toBe(200);

    await apiPool.query("update access_tokens set expires_at = now() - interval '1 minute' where id = $1", [live.res.json().id]);
    expect((await tool(live.token)("GET", `/drawers/${d.id}`)).statusCode).toBe(401);

    const list = (await A.call("GET", "/me/tokens")).json().tokens as { id: string }[];
    expect(list.map((t) => t.id)).toContain(live.res.json().id);
    expect(list.map((t) => t.id)).not.toContain(doomed.res.json().id);
  });

  it("wraps for a token: the owner adds them, the tool reads its own, a token cannot add any (PETTY-169)", async () => {
    const d = await drawer(A, "Cellar");
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
    const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    const secret = patSecret();
    const id = tokenId();
    const bundle = await sealPatBundle(secret, id, { v: 1, user_id: A.id, drawers: [] });
    const created = await A.call("POST", "/me/tokens", { token_id: id, ecdh_pub: pub, name: "wrapped", role: "read", scope: null, expires_at: null, bundle, proof: await A.proof() });
    expect(created.statusCode).toBe(201);
    expect(created.json().ecdh_pub).toBe(pub);
    const tokenRowId = created.json().id as string;
    const token = patToken(id, secret);

    // nothing yet
    expect((await A.call("GET", `/me/tokens/${tokenRowId}/keys`)).json().keys).toEqual([]);

    const wrapRow = (await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === d.id);
    const key = await A.unwrap(wrapRow, A.user.pub.ecdh, true);
    const forToken = await wrapDrawerKey(key, { ecdhPrivate: A.user.keys.ecdh.privateKey, ecdhPublicB64: A.user.pub.ecdh }, pub, d.id, 1);
    expect((await A.call("POST", `/me/tokens/${tokenRowId}/keys`, { keys: [{ drawer_id: d.id, key_version: 1, wrap: forToken }] })).statusCode).toBe(204);
    expect((await A.call("GET", `/me/tokens/${tokenRowId}/keys`)).json().keys).toEqual([{ drawer_id: d.id, key_version: 1 }]);

    // the tool reads its own wraps
    const own = await tool(token)("GET", "/me/token/keys");
    expect(own.statusCode).toBe(200);
    expect(own.json().keys[0].drawer_id).toBe(d.id);

    // a token cannot add wraps, and a drawer the owner is not in cannot be wrapped
    expect((await tool(token)("POST", `/me/tokens/${tokenRowId}/keys`, { keys: [] })).statusCode).toBe(403);
    const theirs = await drawer(B, "Not mine");
    expect((await A.call("POST", `/me/tokens/${tokenRowId}/keys`, { keys: [{ drawer_id: theirs.id, key_version: 1, wrap: forToken }] })).statusCode).toBe(400);
  });

  it("making a token needs the signing key, not only a session (PETTY-181)", async () => {
    const secret = patSecret();
    const id = tokenId();
    const bundle = await sealPatBundle(secret, id, { v: 1, user_id: A.id, drawers: [] });
    const base = { token_id: id, name: "no proof", role: "read", scope: null, expires_at: null, bundle };
    expect((await A.call("POST", "/me/tokens", base)).statusCode).toBe(400);
    // a proof signed with someone else's key is refused
    const foreign = await A.proof(B.user.keys.ecdsa.privateKey);
    expect((await A.call("POST", "/me/tokens", { ...base, proof: foreign })).statusCode).toBe(403);
    expect((await A.call("POST", "/me/tokens", { ...base, proof: await A.proof() })).statusCode).toBe(201);
  });

  it("a made-up token id is refused", async () => {
    const d = await drawer(A, "Ghost");
    const res = await app.inject({ method: "GET", url: `/drawers/${d.id}`, headers: { authorization: `Bearer petty_pat_${tokenId()}` } });
    expect(res.statusCode).toBe(401);
  });
});
