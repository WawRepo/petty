import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDrawerKey, createPasskeyVault, createVault, fromB64, generateUserKeys, openDocument, patSecret, reseal, sealPatBundle, toB64, unwrapDrawerKey } from "@petty/crypto";
import { applyOp, newDocument, type DrawerDocument } from "@petty/ledger";
import { DOCUMENT_MIN_CIPHERTEXT, ENTRY_MAX_CIPHERTEXT, ENTRY_MIN_CIPHERTEXT, MAX_ACCESS_TOKENS, MAX_PASSKEYS, TOKEN_BUNDLE_MAX_CIPHERTEXT, USER_DOC_MAX_CIPHERTEXT } from "@petty/protocol";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, sealedBody, userMaterial } from "../src/devtools/fixtures.js";

/**
 * PETTY-440, PETTY-441, PETTY-442: key rotation and deleting a line need a custody proof, and every
 * field a request stores has a size. Permission tests call the API directly.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
let A: Client, B: Client, C: Client, D: Client; // owner, write member, read member; D has no token and no passkey yet

const mk = async (n: string) => {
  const c = new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }));
  expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
  return c;
};
const fake = (n: number) => Buffer.alloc(n, 7).toString("base64"); // the server never opens ciphertext; size is all it sees
const random = (n: number) => toB64(crypto.getRandomValues(new Uint8Array(n)));
const setQuota = (bytes: number | null) => { (config as { storageQuotaBytes: number | null }).storageQuotaBytes = bytes; };
const storage = async (c: Client) => (await c.call("GET", "/me/storage")).json() as { used_bytes: number; quota_bytes: number | null };

beforeAll(async () => {
  await app.ready();
  [A, B, C, D] = await Promise.all([mk("alice"), mk("bob"), mk("carol"), mk("dave")]);
}, 120_000);
afterEach(() => setQuota(null));
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

/** A drawer of `who` with one money line and two real, signed entries; shared with `members`. */
async function drawer(who: Client, members: [Client, "write" | "read"][] = []) {
  const line = crypto.randomUUID();
  const doc = applyOp(newDocument("Kitchen"), { type: "add_line", line: { id: line, kind: "money", name: "PLN", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
  const { id, key, res } = await who.createDrawer("Kitchen", doc);
  expect(res.statusCode).toBe(201);
  expect((await who.postEntry(id, key, line, "add", 100)).res.statusCode).toBe(201);
  expect((await who.postEntry(id, key, line, "add", 250)).res.statusCode).toBe(201);
  for (const [m, role] of members) {
    const exKey = await who.unwrap((await who.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), who.user.pub.ecdh, true);
    const inv = await who.call("POST", `/drawers/${id}/invitations`, { invitee_id: m.id, role, wrap: await who.wrapFor(exKey, m.user.pub.ecdh, id, 1) });
    expect(inv.statusCode).toBe(201);
    expect((await m.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
  }
  return { id, key, line, doc };
}

/** Someone who signed in as `person` with the login password only: a session, and no key of theirs. */
async function sessionOnly(person: Client) {
  const s = new Client(app, { ...person.user, keys: undefined as never });
  expect((await s.login()).statusCode).toBe(200);
  return s;
}

/** The next drawer key, made by `by` and wrapped for `members`, the way the web app starts a rotation. */
async function nextKey(by: Client, id: string, toVersion: number, members: Client[]) {
  const { selfWrap } = await createDrawerKey(by.sender, id, toVersion);
  const key = await unwrapDrawerKey(selfWrap, by.user.keys.ecdh.privateKey, { drawer_id: id, key_version: toVersion, senderEcdhPublicB64: by.user.pub.ecdh }, { extractable: true });
  const wraps = [];
  for (const m of members) wraps.push({ user_id: m.id, wrap: await by.wrapFor(key, m.user.pub.ecdh, id, toVersion) });
  return { key, wraps };
}

interface Row { id: string; line_id: string; author_id: string; nonce: string; ciphertext: string; key_version: number }
/** One exported entry re-sealed under the next key, as a rotation batch carries it. */
async function resealed(id: string, oldKey: CryptoKey, newKey: CryptoKey, row: Row, toVersion: number) {
  const identity = { record_type: "entry" as const, record_id: row.id, drawer_id: id, line_id: row.line_id, author_id: row.author_id, key_version: row.key_version, schema_version: 1 };
  const r = await reseal(oldKey, newKey, identity, { nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) }, toVersion);
  return { id: row.id, nonce: toB64(r.sealed.nonce), ciphertext: toB64(r.sealed.ciphertext) };
}
async function resealedDocument(who: Client, id: string, oldKey: CryptoKey, newKey: CryptoKey, toVersion: number) {
  const d = (await who.call("GET", `/drawers/${id}`)).json().document;
  const doc = await openDocument(oldKey, { record_type: "document", record_id: id, drawer_id: id, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: 1 }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) });
  // the row keeps its author, so the new seal is bound to the same one
  const author = new Client(app, who.user, d.author_id);
  return sealedBody(await author.sealDoc(id, newKey, doc as DrawerDocument, toVersion), toVersion);
}

const stored = async (drawerId: string) => ({
  entries: (await owner.query<{ id: string; c: string; kv: number }>("select id, encode(ciphertext, 'hex') as c, key_version as kv from entries where drawer_id = $1 order by seq", [drawerId])).rows,
  document: (await owner.query<{ c: string; kv: number }>("select encode(ciphertext, 'hex') as c, key_version as kv from drawer_documents where drawer_id = $1", [drawerId])).rows[0]!,
  drawer: (await owner.query<{ key_version: number; version: number; rotation_needed: boolean }>("select key_version, version, rotation_needed from drawers where id = $1", [drawerId])).rows[0]!,
});

describe("key rotation needs a custody proof (PETTY-440)", () => {
  it("a session without the vault key can neither start a rotation nor send a batch; nothing changes", async () => {
    const { id } = await drawer(A);
    const before = await stored(id);
    const S = await sessionOnly(A);
    const ids = before.entries.map((e) => e.id);
    const wraps = [{ user_id: S.id, wrap: { v: 1, drawer_id: id, key_version: 2, sender_ecdh_pub: random(91), salt: random(32), wrapped: random(40) } }];
    const batch = { to_version: 2, entries: ids.map((i) => ({ id: i, nonce: random(12), ciphertext: random(528) })), document: { key_version: 2, schema_version: 1, nonce: random(12), ciphertext: random(DOCUMENT_MIN_CIPHERTEXT) } };

    // no proof at all, a made-up proof, and a real challenge signed with a key that is not the account's
    expect((await S.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps })).json().code).toBe("CustodyProofRequired");
    expect((await S.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps, proof: { challenge: random(32), signature: random(64) } })).json().code).toBe("CustodyProofRequired");
    const other = await generateUserKeys();
    const foreign = await S.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps, proof: await S.proof(other.ecdsa.privateKey) });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().code).toBe("CustodyProofInvalid");
    for (const proof of [undefined, { challenge: random(32), signature: random(64) }, await S.proof(other.ecdsa.privateKey)]) {
      expect((await S.call("PUT", `/drawers/${id}/rotation/batch`, { ...batch, ...(proof ? { proof } : {}) })).statusCode).toBe(403);
    }
    expect(await stored(id)).toEqual(before);

    // the same holds once a rotation is under way: its batches cannot come from that session either
    const { wraps: real } = await nextKey(A, id, 2, [A]);
    expect((await A.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps: real, proof: await A.proof() })).statusCode).toBe(201);
    const pending = await stored(id);
    expect(pending.drawer.key_version).toBe(2);
    for (const proof of [undefined, { challenge: random(32), signature: random(64) }, await S.proof(other.ecdsa.privateKey)]) {
      const res = await S.call("PUT", `/drawers/${id}/rotation/batch`, { ...batch, ...(proof ? { proof } : {}) });
      expect(res.statusCode).toBe(403);
      expect(["CustodyProofRequired", "CustodyProofInvalid"]).toContain(res.json().code);
    }
    expect(await stored(id)).toEqual(pending);
    expect((await A.call("GET", `/drawers/${id}/rotation`)).json()).toMatchObject({ pending_entries: 2, document_pending: true, completed: false });
  }, 60_000);

  it("a request without a proof, as a web app from before sends it, gets 403 CustodyProofRequired; the rotation stays pending and another write member finishes it", async () => {
    const { id, key } = await drawer(A, [[B, "write"]]);
    const { key: key2, wraps } = await nextKey(A, id, 2, [A, B]);
    const before = await stored(id);

    const oldStart = await A.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps });
    expect(oldStart.statusCode).toBe(403);
    expect(oldStart.json().code).toBe("CustodyProofRequired");
    expect(await stored(id)).toEqual(before);

    expect((await A.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps, proof: await A.proof() })).statusCode).toBe(201);
    const rows = (await A.call("GET", `/drawers/${id}/export`)).json().entries as Row[];
    const first = await resealed(id, key, key2, rows[0]!, 2);
    const pending = await stored(id);
    const oldBatch = await A.call("PUT", `/drawers/${id}/rotation/batch`, { to_version: 2, entries: [first] });
    expect(oldBatch.statusCode).toBe(403);
    expect(oldBatch.json().code).toBe("CustodyProofRequired");
    expect(await stored(id)).toEqual(pending);
    // the drawer still works meanwhile: old rows read as before, new writes use the new key
    expect((await A.postEntry(id, key2, rows[0]!.line_id, "add", 1, { keyVersion: 2 })).res.statusCode).toBe(201);

    // one proof is good for one batch
    const proof = await A.proof();
    expect((await A.call("PUT", `/drawers/${id}/rotation/batch`, { to_version: 2, entries: [first], proof })).json()).toMatchObject({ pending_entries: 1, completed: false });
    expect((await A.call("PUT", `/drawers/${id}/rotation/batch`, { to_version: 2, entries: [], proof })).json().code).toBe("CustodyProofRequired");
    // B continues what A began, with a proof of B's own key
    const bKey2 = await B.unwrap((await B.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string; key_version: number }) => w.drawer_id === id && w.key_version === 2), A.user.pub.ecdh);
    const rest = { to_version: 2, entries: [await resealed(id, key, bKey2, rows[1]!, 2)], document: await resealedDocument(B, id, key, bKey2, 2) };
    expect((await B.call("PUT", `/drawers/${id}/rotation/batch`, { ...rest, proof: await B.proof(A.user.keys.ecdsa.privateKey) })).json().code).toBe("CustodyProofInvalid");
    const done = await B.call("PUT", `/drawers/${id}/rotation/batch`, { ...rest, proof: await B.proof() });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ pending_entries: 0, document_pending: false, completed: true });
    const after = await stored(id);
    expect(after.entries.every((e) => e.kv === 2)).toBe(true);
    expect(after.document.kv).toBe(2);
  }, 60_000);

  it("a read member with a proof is still refused, and an access token can call none of this", async () => {
    const { id, line, doc, key } = await drawer(A, [[C, "read"]]);
    const { wraps } = await nextKey(A, id, 2, [A, C]);
    const before = await stored(id);
    expect((await C.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps, proof: await C.proof() })).json().code).toBe("InsufficientRole");
    expect((await C.call("PUT", `/drawers/${id}/rotation/batch`, { to_version: 1, entries: [], proof: await C.proof() })).json().code).toBe("InsufficientRole");

    const token = await A.makeAccessToken("write");
    expect(token.res.statusCode).toBe(201);
    const tool = (method: "POST" | "PUT", url: string, body: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token.bearer}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
    const without = applyOp(doc, { type: "remove_line", line_id: line }, { lineHasEntries: () => true });
    for (const res of [
      await tool("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps, proof: await A.proof() }),
      await tool("PUT", `/drawers/${id}/rotation/batch`, { to_version: 1, entries: [], proof: await A.proof() }),
      await tool("POST", `/drawers/${id}/lines/${line}/delete`, { document: { ...sealedBody(await A.sealDoc(id, key, without), 1), base_version: 1 }, proof: await A.proof() }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("TokenNotAllowed");
    }
    expect(await stored(id)).toEqual(before);
  }, 60_000);
});

describe("deleting a line needs a custody proof (PETTY-441)", () => {
  it("a session without the vault key cannot delete a line; a member with the key and the write role can", async () => {
    const { id, line, doc, key } = await drawer(A, [[B, "write"], [C, "read"]]);
    const before = await stored(id);
    const without = applyOp(doc, { type: "remove_line", line_id: line }, { lineHasEntries: () => true });
    const body = async (who: Client, baseVersion = 1) => ({ document: { ...sealedBody(await who.sealDoc(id, key, without), 1), base_version: baseVersion } });

    const S = await sessionOnly(B);
    const junk = { document: { key_version: 1, schema_version: 1, nonce: random(12), ciphertext: random(DOCUMENT_MIN_CIPHERTEXT), base_version: 1 } };
    const other = await generateUserKeys();
    // as a web app from before sends it (no proof), with a made-up proof, and with one signed by another key
    const old = await S.call("POST", `/drawers/${id}/lines/${line}/delete`, junk);
    expect(old.statusCode).toBe(403);
    expect(old.json().code).toBe("CustodyProofRequired");
    expect((await S.call("POST", `/drawers/${id}/lines/${line}/delete`, { ...junk, proof: { challenge: random(32), signature: random(64) } })).json().code).toBe("CustodyProofRequired");
    expect((await S.call("POST", `/drawers/${id}/lines/${line}/delete`, { ...junk, proof: await S.proof(other.ecdsa.privateKey) })).json().code).toBe("CustodyProofInvalid");
    expect(await stored(id)).toEqual(before);

    // the read role is refused whatever it proves
    expect((await C.call("POST", `/drawers/${id}/lines/${line}/delete`, { ...(await body(C)), proof: await C.proof() })).json().code).toBe("InsufficientRole");
    // a proof is spent by a refused attempt too: the next try needs a new one
    const proof = await B.proof();
    expect((await B.call("POST", `/drawers/${id}/lines/${line}/delete`, { ...(await body(B, 7)), proof })).json().code).toBe("VersionConflict");
    expect((await B.call("POST", `/drawers/${id}/lines/${line}/delete`, { ...(await body(B)), proof })).json().code).toBe("CustodyProofRequired");
    expect(await stored(id)).toEqual(before);

    const res = await B.call("POST", `/drawers/${id}/lines/${line}/delete`, { ...(await body(B)), proof: await B.proof() });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted_entries).toBe(2);
    expect((await stored(id)).entries).toEqual([]);
  }, 60_000);
});

describe("every stored field has a size (PETTY-442)", () => {
  const entryBody = (line: string, over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), line_id: line, is_checkpoint: false, reverses_entry_id: null, key_version: 1, schema_version: 1, nonce: random(12), ciphertext: fake(528), ...over });
  const refused = (res: { statusCode: number; json: () => { code: string; context?: { path?: string } } }, path: string) => {
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "ValidationError", context: { path } });
  };

  it("an entry's nonce is 12 bytes and its ciphertext at least one padded block; anything else is refused and nothing is stored", async () => {
    const U = B;
    const { id, line } = await drawer(U);
    setQuota(1024 * 1024);
    const before = await storage(U);
    const count = async () => (await owner.query<{ n: number }>("select count(*)::int as n from entries where drawer_id = $1", [id])).rows[0]!.n;
    for (const nonce of [fake(1_400_000), fake(11), fake(13), fake(0), `${fake(12)}=`]) refused(await U.call("POST", `/drawers/${id}/entries`, entryBody(line, { nonce })), "nonce");
    for (const n of [0, 16, ENTRY_MIN_CIPHERTEXT - 1]) {
      const small = await U.call("POST", `/drawers/${id}/entries`, entryBody(line, { ciphertext: fake(n) }));
      expect(small.statusCode).toBe(400);
      expect(small.json()).toMatchObject({ code: "EntryTooSmall", context: { min_bytes: ENTRY_MIN_CIPHERTEXT } });
    }
    expect((await U.call("POST", `/drawers/${id}/entries`, entryBody(line, { ciphertext: fake(ENTRY_MAX_CIPHERTEXT + 1) }))).json().code).toBe("EntryTooLarge");
    expect(await count()).toBe(2);
    expect(await storage(U)).toEqual(before);
    // the smallest and the largest entry a client can write are accepted
    expect((await U.call("POST", `/drawers/${id}/entries`, entryBody(line, { ciphertext: fake(ENTRY_MIN_CIPHERTEXT) }))).statusCode).toBe(201);
    expect((await U.call("POST", `/drawers/${id}/entries`, entryBody(line, { ciphertext: fake(ENTRY_MAX_CIPHERTEXT) }))).statusCode).toBe(201);
  }, 60_000);

  it("what the storage page reports is what the rows hold: only ciphertext varies in size", async () => {
    const U = C;
    const { id, key, line, doc } = await drawer(U);
    expect((await U.call("PUT", `/drawers/${id}/document`, { ...sealedBody(await U.sealDoc(id, key, { ...doc, name: "Renamed" }), 1), base_version: 1 })).statusCode).toBe(200);
    expect((await U.call("PUT", `/drawers/${id}/photo`, { key_version: 1, schema_version: 1, nonce: random(12), ciphertext: fake(40_000) })).statusCode).toBe(204);
    expect((await U.postEntry(id, key, line, "add", 5)).res.statusCode).toBe(201);
    const { rows } = await owner.query<{ t: string; rows: number; nonce: number; ciphertext: number }>(
      `select t, count(*)::int as rows, sum(octet_length(nonce))::int as nonce, sum(octet_length(ciphertext))::int as ciphertext from (
         select 'entries' as t, drawer_id, nonce, ciphertext from entries
         union all select 'documents', drawer_id, nonce, ciphertext from drawer_documents
         union all select 'history', drawer_id, nonce, ciphertext from drawer_document_history
         union all select 'photos', drawer_id, nonce, ciphertext from drawer_photos) x
        where drawer_id in (select id from drawers where owner_id = $1) group by t`,
      [U.id],
    );
    expect(rows.map((r) => r.t).sort()).toEqual(["documents", "entries", "history", "photos"]);
    for (const r of rows) expect(r.nonce).toBe(12 * r.rows);
    expect((await storage(U)).used_bytes).toBe(rows.reduce((n, r) => n + r.ciphertext, 0));
  }, 60_000);

  it("a document is at least one padded block, in a new drawer, a saved document and a deleted line", async () => {
    const U = B;
    const { id, line } = await drawer(U);
    const small = { key_version: 1, schema_version: 1, nonce: random(12), ciphertext: fake(DOCUMENT_MIN_CIPHERTEXT - 1) };
    const newId = crypto.randomUUID();
    const { selfWrap } = await createDrawerKey(U.sender, newId, 1);
    expect((await U.call("POST", "/drawers", { id: newId, document: small, self_wrap: selfWrap })).json()).toMatchObject({ code: "DocumentTooSmall", context: { min_bytes: DOCUMENT_MIN_CIPHERTEXT } });
    expect((await U.call("PUT", `/drawers/${id}/document`, { ...small, base_version: 1 })).json().code).toBe("DocumentTooSmall");
    expect((await U.call("POST", `/drawers/${id}/lines/${line}/delete`, { document: { ...small, base_version: 1 }, proof: await U.proof() })).json().code).toBe("DocumentTooSmall");
    expect((await owner.query("select 1 from drawers where id = $1", [newId])).rowCount).toBe(0);
    expect((await stored(id)).drawer.version).toBe(1);
    expect((await stored(id)).entries).toHaveLength(2);
  }, 60_000);

  it("a rotation batch keeps the entry and photo size limits and the quota; rows of the same size always pass", async () => {
    const U = C;
    const { id, key } = await drawer(U);
    expect((await U.call("PUT", `/drawers/${id}/photo`, { key_version: 1, schema_version: 1, nonce: random(12), ciphertext: fake(40_000) })).statusCode).toBe(204);
    const { key: key2, wraps } = await nextKey(U, id, 2, [U]);
    expect((await U.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps, proof: await U.proof() })).statusCode).toBe(201);
    const rows = (await U.call("GET", `/drawers/${id}/export`)).json().entries as Row[];
    const used = (await storage(U)).used_bytes;
    const pending = await stored(id);
    setQuota(used); // the account is full
    const batch = async (body: Record<string, unknown>) => U.call("PUT", `/drawers/${id}/rotation/batch`, { to_version: 2, entries: [], ...body, proof: await U.proof() });

    const big = await batch({ entries: [{ id: rows[0]!.id, nonce: random(12), ciphertext: fake(1_400_000) }] });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: "EntryTooLarge", context: { max_bytes: ENTRY_MAX_CIPHERTEXT } });
    // within the entry limit, but more than the row it replaces: that is new storage, and there is none left
    const grown = await batch({ entries: [{ id: rows[0]!.id, nonce: random(12), ciphertext: fake(ENTRY_MAX_CIPHERTEXT) }] });
    expect(grown.statusCode).toBe(413);
    expect(grown.json().code).toBe("StorageQuotaExceeded");
    expect((await batch({ photo: { key_version: 2, schema_version: 1, nonce: random(12), ciphertext: fake(400_000) } })).json().code).toBe("PhotoTooLarge");
    expect((await batch({ document: { key_version: 2, schema_version: 1, nonce: random(12), ciphertext: fake(DOCUMENT_MIN_CIPHERTEXT * 2) } })).json().code).toBe("StorageQuotaExceeded");
    refused(await batch({ entries: [{ id: rows[0]!.id, nonce: fake(1_400_000), ciphertext: fake(528) }] }), "entries.0.nonce");
    expect(await stored(id)).toEqual(pending);
    expect((await storage(U)).used_bytes).toBe(used);

    // the real re-seal adds nothing, so it passes on a full account
    const done = await batch({
      entries: [await resealed(id, key, key2, rows[0]!, 2), await resealed(id, key, key2, rows[1]!, 2)],
      document: await resealedDocument(U, id, key, key2, 2),
      photo: { key_version: 2, schema_version: 1, nonce: random(12), ciphertext: fake(40_000) },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ completed: true });
    expect((await storage(U)).used_bytes).toBe(used);
  }, 60_000);

  it("wrapped keys, vault parts, public keys, proofs and bundles of the wrong size are refused on every route that stores them", async () => {
    const U = B;
    const { id, key } = await drawer(U);
    const long = "A".repeat(4096);
    const exKey = await U.unwrap((await U.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), U.user.pub.ecdh, true);
    const wrap = await U.wrapFor(exKey, C.user.pub.ecdh, id, 1);
    const doc = sealedBody(await U.sealDoc(id, key, newDocument("x")), 1);

    // a new drawer
    const newId = crypto.randomUUID();
    const { selfWrap } = await createDrawerKey(U.sender, newId, 1);
    refused(await U.call("POST", "/drawers", { id: newId, document: doc, self_wrap: { ...selfWrap, salt: long } }), "self_wrap.salt");
    refused(await U.call("POST", "/drawers", { id: newId, document: doc, self_wrap: { ...selfWrap, wrapped: fake(41) } }), "self_wrap.wrapped");
    refused(await U.call("POST", "/drawers", { id: newId, document: doc, self_wrap: { ...selfWrap, sender_ecdh_pub: long } }), "self_wrap.sender_ecdh_pub");
    refused(await U.call("POST", "/drawers", { id: newId, document: { ...doc, nonce: fake(16) }, self_wrap: selfWrap }), "document.nonce");
    // a saved document and a photo
    refused(await U.call("PUT", `/drawers/${id}/document`, { ...doc, nonce: long, base_version: 1 }), "nonce");
    refused(await U.call("PUT", `/drawers/${id}/photo`, { key_version: 1, schema_version: 1, nonce: long, ciphertext: fake(40_000) }), "nonce");
    // an invitation and a rotation
    refused(await U.call("POST", `/drawers/${id}/invitations`, { invitee_id: C.id, role: "read", wrap: { ...wrap, salt: long } }), "wrap.salt");
    refused(await U.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps: [{ user_id: U.id, wrap: { ...wrap, key_version: 2, wrapped: long } }], proof: await U.proof() }), "wraps.0.wrap.wrapped");
    refused(await U.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps: [{ user_id: U.id, wrap: { ...wrap, key_version: 2 } }], proof: { challenge: long, signature: random(64) } }), "proof.challenge");
    refused(await U.call("DELETE", `/drawers/${id}`, { proof: { challenge: random(32), signature: long } }), "proof.signature");
    // the person's own document
    refused(await U.call("PUT", "/me/doc", { base_version: 0, schema_version: 1, nonce: random(12), ciphertext: fake(USER_DOC_MAX_CIPHERTEXT + 1) }), "ciphertext");
    refused(await U.call("PUT", "/me/doc", { base_version: 0, schema_version: 1, nonce: long, ciphertext: fake(DOCUMENT_MIN_CIPHERTEXT) }), "nonce");
    expect((await U.call("PUT", "/me/doc", { base_version: 0, schema_version: 1, nonce: random(12), ciphertext: fake(USER_DOC_MAX_CIPHERTEXT) })).statusCode).toBe(200);
    // the vault copies and a passkey
    const vault = await createVault(U.user.passphrase, U.user.keys);
    const put = async (v: unknown) => U.call("PUT", "/me/vault", { password: U.user.password, proof: await U.proof(), vault: v });
    refused(await put({ ...vault, kdf: { ...vault.kdf, salt: long } }), "vault.kdf.salt");
    refused(await put({ ...vault, ecdh: { ...vault.ecdh, ct: long } }), "vault.ecdh.ct");
    refused(await put({ ...vault, ecdsa: { ...vault.ecdsa, iv: fake(16) } }), "vault.ecdsa.iv");
    refused(await put({ ...vault, pub: { ...vault.pub, ecdh: long } }), "vault.pub.ecdh");
    expect((await put(vault)).statusCode).toBe(204);
    const passkey = { credential_id: random(16), prf_salt: random(32), vault: await createPasskeyVault(crypto.getRandomValues(new Uint8Array(32)), U.user.keys), label: "Phone", transports: ["internal"] };
    refused(await U.call("POST", "/me/passkeys", { password: U.user.password, proof: await U.proof(), passkey: { ...passkey, prf_salt: long } }), "passkey.prf_salt");
    // a new account
    const signup = { ...U.user.signupBody, email: `fresh-${run}@test.local` } as unknown as { keys: Record<string, string>; recovery_vault: { ecdsa: Record<string, string> } };
    refused(await app.inject({ method: "POST", url: "/auth/signup", payload: { ...signup, join_token: await makeJoinLink(), keys: { ...signup.keys, ecdh_pub: long } } }), "keys.ecdh_pub");
    refused(await app.inject({ method: "POST", url: "/auth/signup", payload: { ...signup, join_token: await makeJoinLink(), recovery_vault: { ...signup.recovery_vault, ecdsa: { ...signup.recovery_vault.ecdsa, ct: long } } } }), "recovery_vault.ecdsa.ct");
    // an access token
    const tokenId = random(24).replace(/[+/=]/g, "_");
    const bundle = await sealPatBundle(patSecret(), tokenId, { v: 1, user_id: U.id, drawers: [] });
    const signing = await U.tokenSigning();
    const token = async (over: Record<string, unknown>) => U.call("POST", "/me/tokens", { token_id: tokenId, name: "t", role: "write", scope: null, expires_at: null, bundle, proof: await U.proof(), signing: signing.body, ...over });
    refused(await token({ bundle: { ...bundle, ciphertext: fake(TOKEN_BUNDLE_MAX_CIPHERTEXT + 1) } }), "bundle.ciphertext");
    refused(await token({ bundle: { ...bundle, nonce: long } }), "bundle.nonce");
    refused(await token({ ecdh_pub: long }), "ecdh_pub");
    refused(await token({ signing: { ...signing.body, delegation: { ...signing.body.delegation, sig: long } } }), "signing.delegation.sig");
    refused(await token({ signing: { ...signing.body, delegation: { ...signing.body.delegation, created_at: `2026-01-01T00:00:00.${"0".repeat(4000)}Z` } } }), "signing.delegation.created_at");
    expect((await token({})).statusCode).toBe(201);
  }, 120_000);

  it("a token gets wrapped keys only for key versions its owner holds, and each wrap must name its own drawer and version", async () => {
    const U = C;
    const { id } = await drawer(U);
    const other = await drawer(U);
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
    const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    const tokenId = random(24).replace(/[+/=]/g, "_");
    const made = await U.call("POST", "/me/tokens", { token_id: tokenId, ecdh_pub: pub, name: "keys", role: "read", scope: null, expires_at: null, bundle: await sealPatBundle(patSecret(), tokenId, { v: 1, user_id: U.id, drawers: [] }), proof: await U.proof() });
    expect(made.statusCode).toBe(201);
    const exKey = await U.unwrap((await U.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), U.user.pub.ecdh, true);
    const keys = `/me/tokens/${made.json().id}/keys`;
    const rows = async () => (await owner.query<{ n: number }>("select count(*)::int as n from access_token_keys where token_id = $1", [made.json().id])).rows[0]!.n;

    for (const version of [2, 999_999]) {
      const res = await U.call("POST", keys, { keys: [{ drawer_id: id, key_version: version, wrap: await U.wrapFor(exKey, pub, id, version) }] });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "KeyVersionUnknown", context: { drawer_id: id, key_version: version } });
    }
    refused(await U.call("POST", keys, { keys: [{ drawer_id: id, key_version: 0, wrap: await U.wrapFor(exKey, pub, id, 1) }] }), "keys.0.key_version");
    const wrap = await U.wrapFor(exKey, pub, id, 1);
    expect((await U.call("POST", keys, { keys: [{ drawer_id: other.id, key_version: 1, wrap }] })).json().code).toBe("WrapMismatch");
    expect((await U.call("POST", keys, { keys: [{ drawer_id: id, key_version: 1, wrap: { ...wrap, key_version: 3 } }] })).json().code).toBe("WrapMismatch");
    expect(await rows()).toBe(0);
    expect((await U.call("POST", keys, { keys: [{ drawer_id: id, key_version: 1, wrap }] })).statusCode).toBe(204);
    expect(await rows()).toBe(1);

    // after a rotation the new version is one the owner holds, and the old one still is
    const { key: key2, wraps } = await nextKey(U, id, 2, [U]);
    expect((await U.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps, proof: await U.proof() })).statusCode).toBe(201);
    expect((await U.call("POST", keys, { keys: [{ drawer_id: id, key_version: 2, wrap: await U.wrapFor(key2, pub, id, 2) }, { drawer_id: id, key_version: 1, wrap }] })).statusCode).toBe(204);
    expect(await rows()).toBe(2);
  }, 60_000);

  it(`an account holds at most ${MAX_ACCESS_TOKENS} live tokens; a revoked or expired one frees its place, and its bundle and wrapped keys are dropped`, async () => {
    const U = D;
    const { id } = await drawer(U);
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
    const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    const make = async (expiresAt: string | null = null) => {
      const tokenId = random(24).replace(/[+/=]/g, "_");
      const res = await U.call("POST", "/me/tokens", { token_id: tokenId, ecdh_pub: pub, name: "t", role: "read", scope: null, expires_at: expiresAt, bundle: await sealPatBundle(patSecret(), tokenId, { v: 1, user_id: U.id, drawers: [] }), proof: await U.proof() });
      return { res, bearer: `petty_pat_${tokenId}` };
    };
    const first = await make();
    expect(first.res.statusCode).toBe(201);
    const exKey = await U.unwrap((await U.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), U.user.pub.ecdh, true);
    expect((await U.call("POST", `/me/tokens/${first.res.json().id}/keys`, { keys: [{ drawer_id: id, key_version: 1, wrap: await U.wrapFor(exKey, pub, id, 1) }] })).statusCode).toBe(204);
    const second = await make(new Date(Date.now() + 60_000).toISOString());
    expect((await U.call("POST", `/me/tokens/${second.res.json().id}/keys`, { keys: [{ drawer_id: id, key_version: 1, wrap: await U.wrapFor(exKey, pub, id, 1) }] })).statusCode).toBe(204);
    for (let i = 2; i < MAX_ACCESS_TOKENS; i++) expect((await make()).res.statusCode).toBe(201);
    const over = await make();
    expect(over.res.statusCode).toBe(409);
    expect(over.res.json()).toMatchObject({ code: "TokenLimit", context: { max: MAX_ACCESS_TOKENS } });
    const row = async (tokenRowId: string) => (await owner.query<{ revoked: boolean; bundle_nonce: string; bundle_ciphertext: string; keys: number }>(
      "select revoked_at is not null as revoked, bundle_nonce, bundle_ciphertext, (select count(*)::int from access_token_keys k where k.token_id = t.id) as keys from access_tokens t where id = $1", [tokenRowId],
    )).rows[0]!;

    // a token that has expired can never be used again: it gives its place back, takes no more keys, and the next token made drops what it stored
    await owner.query("update access_tokens set expires_at = now() - interval '1 minute' where id = $1", [second.res.json().id]);
    expect((await U.call("POST", `/me/tokens/${second.res.json().id}/keys`, { keys: [{ drawer_id: id, key_version: 1, wrap: await U.wrapFor(exKey, pub, id, 1) }] })).json().code).toBe("TokenNotFound");
    expect((await row(second.res.json().id)).keys).toBe(1);
    expect((await make()).res.statusCode).toBe(201);
    expect(await row(second.res.json().id)).toEqual({ revoked: false, bundle_nonce: "", bundle_ciphertext: "", keys: 0 });
    expect((await U.call("GET", "/me/tokens")).json().tokens.map((t: { id: string }) => t.id)).toContain(second.res.json().id); // still listed, as expired
    expect((await make()).res.json().code).toBe("TokenLimit");

    expect((await U.call("DELETE", `/me/tokens/${first.res.json().id}`)).statusCode).toBe(204);
    expect(await row(first.res.json().id)).toEqual({ revoked: true, bundle_nonce: "", bundle_ciphertext: "", keys: 0 });
    const next = await make();
    expect(next.res.statusCode).toBe(201);
    expect((await make()).res.json().code).toBe("TokenLimit");
    // a tool that ends its own token frees its place the same way
    expect((await app.inject({ method: "DELETE", url: "/me/token", headers: { authorization: `Bearer ${next.bearer}` } })).statusCode).toBe(204);
    expect((await owner.query<{ bundle_ciphertext: string }>("select bundle_ciphertext from access_tokens where id = $1", [next.res.json().id])).rows[0]!.bundle_ciphertext).toBe("");
    expect((await make()).res.statusCode).toBe(201);
  }, 120_000);

  it(`an account holds at most ${MAX_PASSKEYS} passkeys; saving one it already has again still works`, async () => {
    const U = D;
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const vault = await createPasskeyVault(prf, U.user.keys);
    const add = async (credentialId: string) => U.call("POST", "/me/passkeys", { password: U.user.password, proof: await U.proof(), passkey: { credential_id: credentialId, prf_salt: random(32), vault, label: "Device", transports: [] } });
    const ids = Array.from({ length: MAX_PASSKEYS }, () => random(16));
    for (const c of ids) expect((await add(c)).statusCode).toBe(201);
    const over = await add(random(16));
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: "PasskeyLimit", context: { max: MAX_PASSKEYS } });
    expect((await add(ids[0]!)).statusCode).toBe(201);
    const me = (await U.call("GET", "/me")).json();
    expect(me.passkeys).toHaveLength(MAX_PASSKEYS);
    expect((await U.call("DELETE", `/me/passkeys/${me.passkeys[0].id}`, { password: U.user.password, proof: await U.proof() })).statusCode).toBe(204);
    expect((await add(random(16))).statusCode).toBe(201);
  }, 120_000);
});
