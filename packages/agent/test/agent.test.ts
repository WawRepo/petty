import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromB64, hashEntry, openEntryUnverified, patSecret, patToken, sealEntry, sealPatBundle, signEntry, toB64, wrapDrawerKey, type EntryPayloadV1, type SignedEntryV1 } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import type { EntryRow, TokenBootstrap } from "@petty/protocol";
import { buildApp } from "../../../apps/api/src/app.js";
import { apiPool, maintPool } from "../../../apps/api/src/db.js";
import { Client, makeJoinLink, userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
import { checkApiUrl, connect, TokenError, warningText, type AgentClient, type AgentWarning } from "../src/index.js";

/**
 * The headless client (PETTY-165) against the real API, in memory. It holds the token, opens the
 * bundle here, decrypts what the bundle covers, and appends entries the owner signs.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
let owner: Client;
let drawerId: string, lineId: string, key: CryptoKey; // key: the drawer key as the owner holds it

/** The app's fetch, pointed at the in-memory server. */
const inject: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const res = await app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST",
    url: url.pathname + url.search,
    headers: init?.headers as Record<string, string>,
    ...(init?.body ? { payload: String(init.body) } : {}),
  });
  return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
};

async function tokenFor(role: "read" | "write"): Promise<string> {
  return (await tokenAndId(role)).token;
}

/**
 * A token made the way the web app makes one: its own ECDH pair, the public half on the server, and the
 * owner's ECDH key sealed in (PETTY-397). `older: true` leaves that key out, as tokens made before did.
 */
async function tokenAndId(role: "read" | "write", opts: { older?: boolean } = {}): Promise<{ token: string; id: string; pair: CryptoKeyPair; pub: string; signing: Awaited<ReturnType<Client["tokenSigning"]>> | null }> {
  const secret = patSecret();
  const id = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
  const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
  const extractable = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
  const raw = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", extractable)));
  const signing = role === "write" ? await owner.tokenSigning() : null;
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const bundle = await sealPatBundle(secret, id, {
    v: 1,
    user_id: owner.id,
    drawers: [{ drawer_id: drawerId, key_version: 1, key: raw }],
    ecdh: toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    ...(opts.older ? {} : { owner_ecdh: owner.user.pub.ecdh }),
    ...(signing ? signing.bundle : {}),
  });
  const res = await owner.call("POST", "/me/tokens", { token_id: id, ecdh_pub: pub, name: `agent-${role}`, role, scope: null, expires_at: null, bundle, proof: await owner.proof(), ...(signing ? { signing: signing.body } : {}) });
  expect(res.statusCode).toBe(201);
  return { token: patToken(id, secret), id: res.json().id as string, pair, pub, signing };
}

beforeAll(async () => {
  await app.ready();
  owner = new Client(app, await userMaterial("agent", { email: `agent-${run}@test.local` }));
  expect((await owner.signup(await makeJoinLink())).statusCode).toBe(201);
  lineId = crypto.randomUUID();
  const doc = applyOp(newDocument("Kitchen"), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
  const made = await owner.createDrawer("Kitchen", doc);
  expect(made.res.statusCode).toBe(201);
  drawerId = made.id;
  key = made.key;
  // a starting balance, written by the owner
  expect((await owner.postEntry(drawerId, key, lineId, "add", 1000)).res.statusCode).toBe(201);
}, 120_000);

afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

const client = async (role: "read" | "write"): Promise<AgentClient> => connect({ token: await tokenFor(role), apiUrl: "https://petty.test", fetch: inject });

describe("headless client (PETTY-165)", () => {
  it("reads the drawers the bundle covers, with balances a person can read", async () => {
    const c = await client("read");
    const drawers = await c.drawers();
    expect(drawers.map((d) => d.name)).toEqual(["Kitchen"]);
    const line = drawers[0]!.lines[0]!;
    expect(line.name).toBe("Cash");
    expect(line.balance).toBe(1000);
    expect(line.amount).toBe("10.00 PLN");
  });

  it("finds an item by words, and says so when the words match nothing", async () => {
    const c = await client("read");
    const hit = await c.find("kitchen cash");
    expect(hit.line.id).toBe(lineId);
    await expect(c.find("bicycle")).rejects.toMatchObject({ code: "NotFound" });
  });

  it("a read token cannot append", async () => {
    const c = await client("read");
    await expect(c.add(drawerId, lineId, "5")).rejects.toMatchObject({ code: "ReadOnly" });
  });

  it("a write token appends, and the new balance comes back in words", async () => {
    const c = await client("write");
    const res = await c.add(drawerId, lineId, "10.50", "from the agent");
    expect(res.amount).toBe("10.50 PLN");
    expect(res.balanceAfter).toBe("20.50 PLN");
    const after = (await c.drawers())[0]!.lines[0]!;
    expect(after.balance).toBe(2050);
    // and the owner sees it in the history, as their own entry
    const history = await c.history(drawerId, lineId);
    expect(history[0]!.comment).toBe("from the agent");
    expect(history[0]!.mine).toBe(true);
    // PETTY-191: history shows the entry's own amount, and the token-signed entry checks out
    expect(history[0]!.amount).toBe("10.50 PLN");
    expect(history.every((h) => h.verified)).toBe(true);
    expect(after.unverified).toBe(0);
  });

  it("withdraw and adjust land as the right operations", async () => {
    const c = await client("write");
    await c.withdraw(drawerId, lineId, "0.50");
    expect((await c.drawers())[0]!.lines[0]!.balance).toBe(2000);
    await c.adjust(drawerId, lineId, "7.25", "counted");
    expect((await c.drawers())[0]!.lines[0]!.balance).toBe(725);
  });

  it("a revoked token is refused, and a wrong secret cannot open the bundle", async () => {
    const token = await tokenFor("read");
    const c = await connect({ token, apiUrl: "https://petty.test", fetch: inject });
    const list = (await owner.call("GET", "/me/tokens")).json().tokens as { id: string; name: string }[];
    const mine = list.find((t) => t.name === "agent-read")!;
    expect((await owner.call("DELETE", `/me/tokens/${mine.id}`)).statusCode).toBe(204);
    await expect(c.drawers()).rejects.toMatchObject({ code: "TokenRevoked" });

    const other = patToken(token.split(".")[0]!.replace("petty_pat_", ""), patSecret());
    await expect(connect({ token: other, apiUrl: "https://petty.test", fetch: inject })).rejects.toBeInstanceOf(Error);
  });

  it("a drawer made after the token reaches it once the owner's app wraps the key (PETTY-169)", async () => {
    const made = await tokenAndId("read");
    const client = await connect({ token: made.token, apiUrl: "https://petty.test", fetch: inject });
    expect((await client.drawers()).map((d) => d.name)).toEqual(["Kitchen"]);

    // the owner makes a new drawer
    const laterLine = crypto.randomUUID();
    const doc = applyOp(newDocument("Attic"), { type: "add_line", line: { id: laterLine, kind: "money", name: "Tin", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const attic = await owner.createDrawer("Attic", doc);
    expect(attic.res.statusCode).toBe(201);
    // the token cannot see it yet
    const before = await connect({ token: made.token, apiUrl: "https://petty.test", fetch: inject });
    expect((await before.drawers()).map((d) => d.name)).toEqual(["Kitchen"]);

    // the owner's app wraps the new drawer key for the token, as syncTokenWraps does
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === attic.id);
    const key = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
    const forToken = await wrapDrawerKey(key, { ecdhPrivate: owner.user.keys.ecdh.privateKey, ecdhPublicB64: owner.user.pub.ecdh }, made.pub, attic.id, 1);
    expect((await owner.call("POST", `/me/tokens/${made.id}/keys`, { keys: [{ drawer_id: attic.id, key_version: 1, wrap: forToken }] })).statusCode).toBe(204);

    // now it does
    const after = await connect({ token: made.token, apiUrl: "https://petty.test", fetch: inject });
    expect((await after.drawers()).map((d) => d.name).sort()).toEqual(["Attic", "Kitchen"]);
  });

  it("a server that names a key of its own as the owner's cannot hand the token a drawer key (PETTY-397)", async () => {
    const made = await tokenAndId("write");
    // The server's own ECDH pair and a drawer key it knows, wrapped for the token as a newer key of Kitchen.
    const server = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
    const serverPub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", server.publicKey)));
    const known = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const forged = await wrapDrawerKey(known, { ecdhPrivate: server.privateKey, ecdhPublicB64: serverPub }, made.pub, drawerId, 2);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const lying: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const res = await inject(input, init);
      if (path === "/me/token") return json({ ...(await res.json() as object), owner_ecdh_pub: serverPub });
      if (path === "/me/token/keys") return json({ keys: [{ drawer_id: drawerId, key_version: 2, wrap: forged }] });
      return res;
    };
    const c = await connect({ token: made.token, apiUrl: "https://petty.test", fetch: lying });
    // Kitchen still opens with the key the owner sealed in, and what the token writes is sealed with it:
    // an honest connection reads the new entry.
    expect((await c.drawers()).find((d) => d.id === drawerId)?.lines[0]?.name).toBe("Cash");
    await c.add(drawerId, lineId, "1", "after the swap");
    const honest = await connect({ token: made.token, apiUrl: "https://petty.test", fetch: inject });
    expect((await honest.history(drawerId, lineId))[0]!.comment).toBe("after the swap");
    expect(c.notice).toBeNull();
  });

  it("a token made before PETTY-397 opens no drawer key wrapped later, and says so", async () => {
    const older = await tokenAndId("read", { older: true });
    const laterLine = crypto.randomUUID();
    const doc = applyOp(newDocument("Cellar"), { type: "add_line", line: { id: laterLine, kind: "money", name: "Jar", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const cellar = await owner.createDrawer("Cellar", doc);
    expect(cellar.res.statusCode).toBe(201);
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === cellar.id);
    const k = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
    const forToken = await wrapDrawerKey(k, { ecdhPrivate: owner.user.keys.ecdh.privateKey, ecdhPublicB64: owner.user.pub.ecdh }, older.pub, cellar.id, 1);
    expect((await owner.call("POST", `/me/tokens/${older.id}/keys`, { keys: [{ drawer_id: cellar.id, key_version: 1, wrap: forToken }] })).statusCode).toBe(204);
    const c = await connect({ token: older.token, apiUrl: "https://petty.test", fetch: inject });
    expect((await c.drawers()).map((d) => d.name)).not.toContain("Cellar");
    expect(c.notice).toMatch(/make a new token/);
  });

  it("tags and places: list, tag, untag, rename onto an existing tag, remove, and move a drawer (PETTY-174/175)", async () => {
    const c = await client("write");
    await c.tagItem(drawerId, lineId, "food");
    await c.tagItem(drawerId, lineId, "Travel");
    expect((await c.tags()).map((t) => t.label)).toEqual(["food", "Travel"]);
    expect((await c.tags())[0]!.holders[0]!.items.map((i) => i.name)).toEqual(["Cash"]);
    // an existing spelling wins, and a tag already there is not doubled
    expect(await c.tagItem(drawerId, lineId, "FOOD")).toEqual(["food", "Travel"]);
    await c.untagItem(drawerId, lineId, "travel");
    expect((await c.drawers())[0]!.lines[0]!.tags).toEqual(["food"]);
    await c.tagItem(drawerId, lineId, "groceries");
    // rename "food" onto "groceries": the two merge
    expect(await c.renameTag("food", "Groceries")).toBe(1);
    expect((await c.drawers())[0]!.lines[0]!.tags).toEqual(["groceries"]);
    expect(await c.removeTag("groceries")).toBe(1);
    expect((await c.tags())).toEqual([]);
    await expect(c.removeTag("nothing")).rejects.toMatchObject({ code: "NotFound" });

    await c.moveDrawer("Kitchen", ["House", "Kitchen shelf"]);
    const places = await c.places();
    expect(places.map((p) => p.name)).toEqual(["House"]);
    expect(places[0]!.children[0]!.name).toBe("Kitchen shelf");
    expect(places[0]!.children[0]!.drawers).toEqual(["Kitchen"]);
    await c.moveDrawer(drawerId, []);
    expect(await c.places()).toEqual([]);
  });

  it("a read token cannot change tags or places", async () => {
    const c = await client("read");
    await expect(c.tagItem(drawerId, lineId, "x")).rejects.toMatchObject({ code: "ReadOnly" });
    await expect(c.moveDrawer(drawerId, ["Somewhere"])).rejects.toMatchObject({ code: "ReadOnly" });
  });

  it("a change made by someone else meanwhile is kept: the write retries on the new version", async () => {
    const c = await client("write");
    await c.drawers();
    // the owner's app renames the item in between
    const got = (await owner.call("GET", `/drawers/${drawerId}`)).json();
    const { applyOps } = await import("@petty/ledger");
    const { openDocument, fromB64 } = await import("@petty/crypto");
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
    const k = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
    const doc = await openDocument(k, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: got.document.author_id, key_version: 1, schema_version: 1 }, { nonce: fromB64(got.document.nonce), ciphertext: fromB64(got.document.ciphertext) });
    const renamed = applyOps(doc as never, [{ type: "rename_line", line_id: lineId, name: "Cash box" }], { lineHasEntries: () => true });
    const sealedDoc = await owner.sealDoc(drawerId, k, renamed);
    expect((await owner.call("PUT", `/drawers/${drawerId}/document`, { base_version: got.drawer.version, key_version: 1, schema_version: 1, nonce: toB64(sealedDoc.nonce), ciphertext: toB64(sealedDoc.ciphertext), verification: false })).statusCode).toBe(200);
    // the token's change still lands, and the rename survives
    await c.tagItem(drawerId, lineId, "kept");
    const line = (await c.drawers())[0]!.lines[0]!;
    expect(line.name).toBe("Cash box");
    expect(line.tags).toEqual(["kept"]);
    await c.untagItem(drawerId, lineId, "kept");
  });

  it("a shared drawer last written by another member still opens (the document's author is read from the row)", async () => {
    const bob = new Client(app, await userMaterial("agent-bob", { email: `agent-bob-${run}@test.local` }));
    expect((await bob.signup(await makeJoinLink())).statusCode).toBe(201);
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
    const k = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
    const inv = await owner.call("POST", `/drawers/${drawerId}/invitations`, { invitee_id: bob.id, role: "write", wrap: await owner.wrapFor(k, bob.user.pub.ecdh, drawerId, 1) });
    expect(inv.statusCode).toBe(201);
    expect((await bob.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
    // Bob renames the drawer, so the document's author is now Bob
    const got = (await bob.call("GET", `/drawers/${drawerId}`)).json();
    const { applyOps } = await import("@petty/ledger");
    const { openDocument, fromB64 } = await import("@petty/crypto");
    const doc = await openDocument(k, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: got.document.author_id, key_version: 1, schema_version: 1 }, { nonce: fromB64(got.document.nonce), ciphertext: fromB64(got.document.ciphertext) });
    const renamed = applyOps(doc as never, [{ type: "rename_drawer", name: "Kitchen (shared)" }], { lineHasEntries: () => true });
    const sealedDoc = await bob.sealDoc(drawerId, k, renamed);
    expect((await bob.call("PUT", `/drawers/${drawerId}/document`, { base_version: got.drawer.version, key_version: 1, schema_version: 1, nonce: toB64(sealedDoc.nonce), ciphertext: toB64(sealedDoc.ciphertext), verification: false })).statusCode).toBe(200);

    const c = await client("read");
    expect((await c.drawers()).map((d) => d.name)).toContain("Kitchen (shared)");
  });

  it("a token cannot reach a drawer outside its bundle", async () => {
    const c = await client("write");
    await expect(c.history(crypto.randomUUID(), lineId)).rejects.toBeInstanceOf(TokenError);
  });

  // PETTY-452: the web app now makes tokens for chosen drawers. This client must work with one.
  it("a token made for chosen drawers lists only those, and says so when asked for another", async () => {
    const outLine = crypto.randomUUID();
    const doc = applyOp(newDocument("Strongbox"), { type: "add_line", line: { id: outLine, kind: "money", name: "Gold", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const outside = await owner.createDrawer("Strongbox", doc);
    expect(outside.res.statusCode).toBe(201);
    // made as the web app makes it: the one drawer's key in the bundle, the one drawer as its scope
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
    const raw = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", await owner.unwrap(wrap, owner.user.pub.ecdh, true))));
    const made = await owner.makeAccessToken("write", [{ drawer_id: drawerId, key_version: 1, key: raw }], [drawerId]);
    expect(made.res.statusCode).toBe(201);

    const c = await connect({ token: made.token, apiUrl: "https://petty.test", fetch: inject });
    expect(c.identity.scope).toEqual([drawerId]);
    const listed = await c.drawers();
    expect(listed.map((d) => d.id)).toEqual([drawerId]);
    expect(listed[0]!.lines.map((l) => l.id)).toContain(lineId);
    // by id: the client knows it is not one of its drawers
    await expect(c.history(outside.id, outLine)).rejects.toMatchObject({ code: "OutOfScope", message: "this token cannot open that drawer" });
    await expect(c.add(outside.id, outLine, "1")).rejects.toMatchObject({ code: "OutOfScope", message: "this token cannot open that drawer" });
    // by name: to this token the drawer does not exist
    await expect(c.find("strongbox gold")).rejects.toMatchObject({ code: "NotFound" });
    await expect(c.findDrawer("Strongbox")).rejects.toMatchObject({ code: "NotFound" });
    // and the server refuses it whatever the client does
    const direct = await app.inject({ method: "GET", url: `/drawers/${outside.id}`, headers: { authorization: `Bearer ${made.bearer}` } });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().code).toBe("TokenOutOfScope");
  });

  it("PETTY-193 (NR-13): the opened bundle is dropped once its keys are imported", async () => {
    const c = await client("write");
    expect((c as unknown as { bundle: unknown }).bundle).toBeNull();
    expect((await c.drawers()).length).toBeGreaterThan(0);
  });

  it("PETTY-191 (NR-11): only https, or http to this machine", () => {
    expect(() => checkApiUrl("https://petty.example.com/api")).not.toThrow();
    expect(() => checkApiUrl("http://localhost:3000")).not.toThrow();
    expect(() => checkApiUrl("http://127.0.0.1:3000/api")).not.toThrow();
    expect(() => checkApiUrl("http://petty.example.com/api")).toThrow(/https/);
    expect(() => checkApiUrl("ftp://petty.example.com")).toThrow(TokenError);
  });

  it("PETTY-191 (NR-11): an entry whose signature does not check out is left out of the balance and flagged", async () => {
    const c = await client("read");
    const before = (await c.drawers())[0]!.lines[0]!;
    expect(before.unverified).toBe(0);
    // a row that claims the owner's key but is signed by another key: what a changed database would hold
    const real = owner.user.keys.ecdsa;
    (owner.user.keys as { ecdsa: CryptoKeyPair }).ecdsa = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    try {
      expect((await owner.postEntry(drawerId, key, lineId, "add", 99_900)).res.statusCode).toBe(201);
    } finally {
      (owner.user.keys as { ecdsa: CryptoKeyPair }).ecdsa = real;
    }
    const after = (await c.drawers())[0]!.lines[0]!;
    expect(after.balance).toBe(before.balance);
    expect(after.unverified).toBe(1);
    const history = await c.history(drawerId, lineId);
    expect(history[0]!.verified).toBe(false);
    expect(history.slice(1).every((h) => h.verified)).toBe(true);
  });

  it("PETTY-336: adds an item the way the app does, with its first entry; a read token cannot", async () => {
    const c = await client("write");
    // JPY has no minor unit: the exponent is set from the code now and stored on the item (rule 5)
    const money = await c.addItem(drawerId, { kind: "money", name: "Holiday", currency: "jpy", start: "5000", comment: "start" });
    expect(money.line).toMatchObject({ name: "Holiday", kind: "money", currency: "JPY", exponent: 0, balance: 5000, unverified: 0 });
    expect((await c.history(drawerId, money.line.id)).map((h) => [h.op, h.comment, h.verified])).toEqual([["add", "start", true]]);
    const count = await c.addItem("Kitchen", { kind: "countable", name: "Batteries", unit: " pcs ", start: "3" });
    expect(count.line).toMatchObject({ kind: "countable", balance: 3, amount: "3" });
    const single = await c.addItem(drawerId, { kind: "single", name: "Spare key", text: "blue box", start: "7" });
    expect(single.line).toMatchObject({ kind: "single", amount: "" });
    expect(await c.history(drawerId, single.line.id)).toEqual([]);

    // what the owner's app opens: the same items, with the unit and the note
    const { openDocument, fromB64 } = await import("@petty/crypto");
    const got = (await owner.call("GET", `/drawers/${drawerId}`)).json();
    const doc = await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: got.document.author_id, key_version: 1, schema_version: 1 }, { nonce: fromB64(got.document.nonce), ciphertext: fromB64(got.document.ciphertext) }) as { lines: { id: string }[] };
    expect(doc.lines.find((l) => l.id === money.line.id)).toMatchObject({ kind: "money", currency: "JPY", exponent: 0 });
    expect(doc.lines.find((l) => l.id === count.line.id)).toMatchObject({ kind: "countable", unit: "pcs" });
    expect(doc.lines.find((l) => l.id === single.line.id)).toMatchObject({ kind: "single", text: "blue box" });

    // refused, and nothing lands: the same name again, no currency, part of a battery, no name
    for (const bad of [
      { kind: "money", name: "HOLIDAY", currency: "EUR" },
      { kind: "money", name: "Coins" },
      { kind: "countable", name: "Coins", start: "1.5" },
      { kind: "single", name: "  " },
    ] as const) await expect(c.addItem(drawerId, bad)).rejects.toMatchObject({ code: "Refused" });
    expect((await c.drawers())[0]!.lines.map((l) => l.name)).not.toContain("Coins");
    await expect((await client("read")).addItem(drawerId, { kind: "single", name: "Note" })).rejects.toMatchObject({ code: "ReadOnly" });
  });

  it("PETTY-339: undoes an entry the way the app's Reverse does, and changes an item", async () => {
    const c = await client("write");
    const lineOf = async (lineId: string) => (await c.drawers()).find((d) => d.id === drawerId)!.lines.find((l) => l.id === lineId)!;
    const id = (await c.addItem(drawerId, { kind: "money", name: "Petrol", currency: "EUR", start: "50" })).line.id;
    const added = await c.add(drawerId, id, "20", "by mistake");
    const undone = await c.undo(drawerId, id, added.id, "typo");
    expect(undone).toMatchObject({ op: "reverse", balanceAfter: "50.00 EUR", comment: "typo", undone: { id: added.id, op: "add", amount: "20.00 EUR", comment: "by mistake" } });
    expect(undone.amount).toMatch(/20\.00 EUR$/);
    // nothing is deleted: the log keeps both, signed, and the balance folds back
    const h = await c.history(drawerId, id);
    expect(h.map((e) => e.op)).toEqual(["reverse", "add", "add"]);
    expect(h.every((e) => e.verified)).toBe(true);
    expect((await lineOf(id)).balance).toBe(5000);
    // refused: the same entry twice, an undo, a count, an entry a later count settled, an unknown id
    await expect(c.undo(drawerId, id, added.id)).rejects.toMatchObject({ code: "Refused", message: "that entry is already undone" });
    await expect(c.undo(drawerId, id, undone.id)).rejects.toMatchObject({ code: "Refused", message: expect.stringContaining("an undo cannot be undone") });
    const counted = await c.adjust(drawerId, id, "50");
    await expect(c.undo(drawerId, id, counted.id)).rejects.toMatchObject({ code: "Refused", message: expect.stringContaining("count again") });
    await expect(c.undo(drawerId, id, h[2]!.id)).rejects.toMatchObject({ code: "Refused", message: expect.stringContaining("latest count") });
    await expect(c.undo(drawerId, id, crypto.randomUUID())).rejects.toMatchObject({ code: "Refused" });

    // a currency code is a label: the item keeps its exponent and its balance (rule 5)
    const edited = await c.editItem(drawerId, id, { name: "Fuel", currency: "usd", counted: false });
    expect(edited.line).toMatchObject({ name: "Fuel", currency: "USD", exponent: 2, balance: 5000, countedInTotal: false });
    const box = (await c.addItem(drawerId, { kind: "countable", name: "Fuses" })).line;
    expect((await c.editItem(drawerId, box.id, { unit: " pcs " })).line.unit).toBe("pcs");
    const key2 = (await c.addItem(drawerId, { kind: "single", name: "Garage key", text: "hook" })).line;
    expect(key2.note).toBe("hook");
    expect((await c.editItem(drawerId, key2.id, { note: "blue box" })).line.note).toBe("blue box");
    // refused, and nothing changes: another item's name, a unit on money, a note on a countable, a bad
    // currency, nothing to change, a total for a single item
    for (const [lineId, change] of [[id, { name: "fuses" }], [id, { unit: "kg" }], [box.id, { note: "x" }], [id, { currency: " " }], [id, {}], [key2.id, { counted: true }]] as const) {
      await expect(c.editItem(drawerId, lineId, change)).rejects.toMatchObject({ code: "Refused" });
    }
    expect(await lineOf(id)).toMatchObject({ name: "Fuel", currency: "USD", unit: null, countedInTotal: false });
    const reader = await client("read");
    await expect(reader.editItem(drawerId, id, { name: "x" })).rejects.toMatchObject({ code: "ReadOnly" });
    await expect(reader.undo(drawerId, id, added.id)).rejects.toMatchObject({ code: "ReadOnly" });
  });

  describe("history checks (PETTY-444, PETTY-445, PETTY-448)", () => {
    /** The rows the server holds for one item, oldest first, opened with the drawer key as the owner would. */
    const rowsOf = async (line: string): Promise<{ row: EntryRow; entry: SignedEntryV1 }[]> => {
      const { entries } = (await owner.call("GET", `/drawers/${drawerId}/lines/${line}/entries?limit=200`)).json() as { entries: EntryRow[] };
      const out = [];
      for (const row of [...entries].reverse()) {
        out.push({ row, entry: await openEntryUnverified(key, { record_type: "entry", record_id: row.id, drawer_id: drawerId, line_id: line, author_id: row.author_id, key_version: row.key_version, schema_version: row.schema_version }, { nonce: fromB64(row.nonce), ciphertext: fromB64(row.ciphertext) }) });
      }
      return out;
    };
    /** Signs, seals and posts one entry with every field chosen here, the plain count flag too. */
    const post = async (line: string, over: Partial<EntryPayloadV1>, body: { is_checkpoint: boolean; expected_head_seq?: number }, as: { privateKey: CryptoKey; sigKeyId: string; bearer?: string } = { privateKey: owner.user.keys.ecdsa.privateKey, sigKeyId: owner.user.sig_key_id }) => {
      const id = crypto.randomUUID();
      const payload: EntryPayloadV1 = { v: 1, id, drawer_id: drawerId, line_id: line, op: "add", amount: 100, exponent: 2, comment: "", logged_at: new Date().toISOString(), reverses: null, prev_hash: null, delta_hint: null, author_id: owner.id, sig_key_id: as.sigKeyId, ...over };
      const signed = await signEntry(payload, as.privateKey);
      const sealed = await sealEntry(key, { record_type: "entry", record_id: id, drawer_id: drawerId, line_id: line, author_id: owner.id, key_version: 1, schema_version: 1 }, signed);
      const json = { id, line_id: line, reverses_entry_id: null, key_version: 1, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext), ...body };
      const res = as.bearer
        ? await app.inject({ method: "POST", url: `/drawers/${drawerId}/entries`, headers: { authorization: `Bearer ${as.bearer}`, "content-type": "application/json" }, payload: JSON.stringify(json) })
        : await owner.call("POST", `/drawers/${drawerId}/entries`, json);
      expect(res.statusCode).toBe(201);
      return signed;
    };
    /** A connection whose start-up load (and, with `page`, each page of older rows) is changed on the way, as a changed database would serve it. */
    const served = async (role: "read" | "write", change: (boot: TokenBootstrap) => void, opts: { onWarnings?: (w: readonly AgentWarning[]) => void; page?: (rows: EntryRow[]) => void } = {}): Promise<AgentClient> => {
      const lying: typeof fetch = async (input, init) => {
        const res = await inject(input, init);
        const path = new URL(String(input)).pathname;
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        if (path === "/me/token/bootstrap") { const boot = (await res.json()) as TokenBootstrap; change(boot); return json(boot); }
        if (opts.page && path.endsWith("/entries") && (init?.method ?? "GET") === "GET") { const body = (await res.json()) as { entries: EntryRow[] }; opts.page(body.entries); return json(body); }
        return res;
      };
      return connect({ token: await tokenFor(role), apiUrl: "https://petty.test", fetch: lying, ...(opts.onWarnings ? { onWarnings: opts.onWarnings } : {}) });
    };
    const about = (c: AgentClient, line: string) => c.warnings.filter((w) => w.lineId === line);
    const item = async (name: string, start = "5"): Promise<string> => (await (await client("write")).addItem(drawerId, { kind: "money", name, currency: "EUR", start })).line.id;
    const lineOf = async (c: AgentClient, line: string) => (await c.drawers()).find((d) => d.id === drawerId)!.lines.find((l) => l.id === line)!;

    it("PETTY-445: an entry a tool writes links to the newest entry it checked, across a count too", async () => {
      const c = await client("write");
      const line = await item("Linked");
      await c.add(drawerId, line, "1");
      await c.withdraw(drawerId, line, "2");
      await c.adjust(drawerId, line, "9");
      const undo = await c.add(drawerId, line, "3");
      await c.undo(drawerId, line, undo.id);
      const rows = await rowsOf(line);
      expect(rows.map((r) => r.entry.op)).toEqual(["add", "add", "withdraw", "adjust", "add", "reverse"]);
      expect(rows[0]!.entry.prev_hash).toBeNull(); // the item's first entry
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.entry.prev_hash).toBe(await hashEntry(rows[i - 1]!.entry));
      expect(await lineOf(c, line)).toMatchObject({ balance: 900, chain: "ok", unreadable: 0, unverified: 0 });
      expect(about(c, line)).toEqual([]);
    });

    it("PETTY-445: entries an older tool wrote without a link are not reported; a second unlinked entry from an account key is", async () => {
      const made = await tokenAndId("write");
      const old = { privateKey: made.signing!.pair.privateKey, sigKeyId: made.signing!.bundle.sig_key_id, bearer: made.token.split(".")[0]! };
      const line = await item("Old tool");
      await post(line, { amount: 200 }, { is_checkpoint: false }, old);
      await post(line, { amount: 300 }, { is_checkpoint: false }, old);
      const c = await connect({ token: made.token, apiUrl: "https://petty.test", fetch: inject });
      expect(await lineOf(c, line)).toMatchObject({ balance: 1000, chain: "ok", unverified: 0 });
      expect(about(c, line)).toEqual([]);
      // the next entry of today's tool links to the newest of them
      await c.add(drawerId, line, "1");
      const rows = await rowsOf(line);
      expect(rows[3]!.entry.prev_hash).toBe(await hashEntry(rows[2]!.entry));
      expect((await lineOf(c, line)).chain).toBe("ok");

      // an account key signs the web app's entries, which always link: a second one without a link is reported
      const other = await item("Unlinked");
      await post(other, { amount: 100 }, { is_checkpoint: false });
      await post(other, { amount: 100 }, { is_checkpoint: false });
      expect(await lineOf(c, other)).toMatchObject({ balance: 700, chain: "broken" });
      expect(about(c, other)).toEqual([{ code: "history_broken", drawerId, drawer: expect.any(String), lineId: other, item: "Unlinked", count: 1 }]);
      expect(warningText(about(c, other)[0]!)).toMatch(/ \/ item "Unlinked": the history links do not match; entries may have been removed or changed$/);
    });

    it("PETTY-445: rows that do not open are counted and reported, on the item, on the drawer, and in history", async () => {
      const line = await item("Damaged");
      const w = await client("write");
      await w.add(drawerId, line, "1");
      await w.add(drawerId, line, "2");
      const ids = (await rowsOf(line)).map((r) => r.row.id);
      const heard: AgentWarning[][] = [];
      // the last two rows trade ciphertexts: each is bound to its own row, so neither opens
      const swap = (rows: EntryRow[]) => {
        const [a, b] = [rows.find((e) => e.id === ids[1]), rows.find((e) => e.id === ids[2])];
        if (a && b) [a.nonce, a.ciphertext, b.nonce, b.ciphertext] = [b.nonce, b.ciphertext, a.nonce, a.ciphertext];
      };
      const c = await served("read", (boot) => swap(boot.entries), { onWarnings: (list) => heard.push([...list]), page: swap });
      expect(await lineOf(c, line)).toMatchObject({ balance: 500, unreadable: 2, unverified: 0, chain: "ok" });
      const mine = about(c, line);
      expect(mine).toEqual([{ code: "entries_unreadable", drawerId, drawer: expect.any(String), lineId: line, item: "Damaged", count: 2 }]);
      expect(warningText(mine[0]!)).toMatch(/ \/ item "Damaged": 2 entries could not be opened; left out of the balance$/);
      expect(heard.at(-1)).toEqual(c.warnings);

      // a row filed under an item the drawer does not list: reported on the drawer
      const stray = await served("read", (boot) => { boot.entries.find((e) => e.id === ids[2])!.line_id = crypto.randomUUID(); });
      const d = (await stray.drawers()).find((x) => x.id === drawerId)!;
      expect(d.unreadable).toBe(1);
      expect(d.lines.find((l) => l.id === line)).toMatchObject({ balance: 600, unreadable: 0 });
      expect(stray.warnings.map((x) => warningText(x))).toContainEqual(expect.stringMatching(/^drawer "[^"]+": 1 entry could not be opened and belong to no item; left out of the balance$/));

      // a drawer whose document does not open is named, not dropped without a word
      const gone = await served("read", (boot) => { boot.documents[drawerId]!.ciphertext = boot.documents[drawerId]!.ciphertext.replace(/^..../, "AAAA"); });
      expect((await gone.drawers()).map((x) => x.id)).not.toContain(drawerId);
      expect(gone.warnings).toContainEqual({ code: "drawer_unreadable", drawerId, drawer: null, lineId: null, item: null, count: 1 });

      // history leaves the same two rows out, and does not count them a second time
      expect((await c.history(drawerId, line)).map((h) => h.id)).toEqual([ids[0]]);
      expect(about(c, line)).toEqual(mine);
      // a row that only the history shows (it lies before the latest count) is counted there
      await w.adjust(drawerId, line, "8");
      const older = await served("read", () => undefined, { page: (rows) => { const r = rows.find((e) => e.id === ids[1]); if (r) r.ciphertext = r.ciphertext.replace(/^..../, "AAAA"); } });
      expect(about(older, line)).toEqual([]);
      expect((await older.history(drawerId, line)).map((h) => h.op)).toEqual(["adjust", "add", "add"]);
      expect(about(older, line)).toEqual([{ code: "entries_unreadable", drawerId, drawer: expect.any(String), lineId: line, item: "Damaged", count: 1 }]);
    });

    it("PETTY-445: the tools check the hash links: an entry missing from the middle is reported", async () => {
      const line = await item("Gap");
      const w = await client("write");
      await w.add(drawerId, line, "1");
      await w.add(drawerId, line, "2");
      const ids = (await rowsOf(line)).map((r) => r.row.id);
      const c = await served("read", (boot) => { boot.entries = boot.entries.filter((e) => e.id !== ids[1]); });
      expect(await lineOf(c, line)).toMatchObject({ balance: 700, chain: "broken" });
      expect(about(c, line).map((x) => x.code)).toEqual(["history_broken"]);
    });

    it("PETTY-448: a row flagged as a count that is not one does not start the balance, and is reported", async () => {
      const line = await item("Flagged", "50");
      const w = await client("write");
      await w.adjust(drawerId, line, "40");
      await w.add(drawerId, line, "2");
      const before = await rowsOf(line);
      // an ordinary "add" stored with the count flag set
      await post(line, { amount: 100, prev_hash: await hashEntry(before.at(-1)!.entry) }, { is_checkpoint: true, expected_head_seq: before.at(-1)!.row.seq });
      await w.add(drawerId, line, "3");
      const c = await client("read");
      // 40.00 counted, then +2, +1, +3: folded from the real count, not from the flagged row
      expect(await lineOf(c, line)).toMatchObject({ balance: 4600, amount: "46.00 EUR", chain: "broken" });
      expect(about(c, line).map((x) => x.code)).toEqual(["history_broken"]);
      // the same when the flagged entry links to nothing, as an item's first entry does
      const bare = await item("Flagged bare", "50");
      await post(bare, { amount: 100 }, { is_checkpoint: true, expected_head_seq: 1 }, { privateKey: owner.user.keys.ecdsa.privateKey, sigKeyId: owner.user.sig_key_id });
      expect(await lineOf(c, bare)).toMatchObject({ balance: 5100, chain: "broken" });
    });

    it("PETTY-448: the same row served twice is refused, not counted twice", async () => {
      const line = await item("Twice");
      const c = await served("read", (boot) => {
        const row = boot.entries.find((e) => e.line_id === line)!;
        boot.entries.push({ ...row, seq: row.seq + 1 });
      });
      await expect(c.drawers()).rejects.toMatchObject({ code: "Refused", message: expect.stringContaining("duplicate_entry") });
    });
  });
});
