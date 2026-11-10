import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromB64, openDocument, wrapDrawerKey } from "@petty/crypto";
import { applyOp, applyOps, newDocument, nextRev, readDocument, type DrawerDocument } from "@petty/ledger";
import { buildApp } from "../src/app.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, sealedBody, userMaterial } from "../src/devtools/fixtures.js";

/**
 * PETTY-422: a drawer document with a counter inside is format 2 (`schema_version`). The server cannot read a
 * document; it keeps the format from going back, and it no longer copies an earlier version into place.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
let owner: Client, member: Client, stranger: Client;

beforeAll(async () => {
  await app.ready();
  const mk = async (n: string) => new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }));
  [owner, member, stranger] = await Promise.all([mk("rev-owner"), mk("rev-member"), mk("rev-stranger")]);
  for (const c of [owner, member, stranger]) expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);

afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

const lineId = crypto.randomUUID();
const withLine = (name: string): DrawerDocument => applyOp(newDocument(name), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });

/** The drawer's document as a client reads it: opened, and checked against the row it came from. */
async function read(c: Client, drawerId: string, key: CryptoKey) {
  const got = (await c.call("GET", `/drawers/${drawerId}`)).json();
  const d = got.document;
  const opened = await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) });
  return { version: got.drawer.version as number, schema: d.schema_version as number, doc: readDocument(opened, { schema_version: d.schema_version, version: got.drawer.version }) };
}
/** One document write, in the given format. */
async function write(c: Client, drawerId: string, key: CryptoKey, doc: DrawerDocument, baseVersion: number, schemaVersion: number) {
  return c.call("PUT", `/drawers/${drawerId}/document`, { ...sealedBody(await c.sealDoc(drawerId, key, doc, 1, schemaVersion), 1, schemaVersion), base_version: baseVersion, verification: false });
}

describe("drawer document format", () => {
  it("a document from before the counter gets its first counter at the next write, and never goes back to the older format", async () => {
    const d = await owner.createDrawer("Tin", withLine("Tin"));
    expect(d.res.statusCode).toBe(201);
    const before = await read(owner, d.id, d.key);
    expect(before).toMatchObject({ version: 1, schema: 1 });
    expect(before.doc.rev).toBeUndefined();

    // a client from before the counter still writes format 1 over format 1
    expect((await write(owner, d.id, d.key, { ...before.doc, name: "Tin 2" }, 1, 1)).statusCode).toBe(200);
    // the first write with a counter
    const second = await read(owner, d.id, d.key);
    expect((await write(owner, d.id, d.key, nextRev(second.doc), second.version, 2)).statusCode).toBe(200);
    const third = await read(owner, d.id, d.key);
    expect(third).toMatchObject({ version: 3, schema: 2 });
    expect(third.doc).toMatchObject({ rev: 1, name: "Tin 2" });

    // format 1 over format 2 is refused, with the right version number too; nothing changes
    const old = await write(owner, d.id, d.key, { ...before.doc, name: "Old client" }, third.version, 1);
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ code: "DocumentFormatOlder", context: { schema_version: 2 } });
    // a stale version number is still the first thing said
    expect((await write(owner, d.id, d.key, before.doc, 1, 1)).json().code).toBe("VersionConflict");
    expect(await read(owner, d.id, d.key)).toMatchObject({ version: 3, doc: { rev: 1, name: "Tin 2" } });

    // deleting a line carries a document too (and a custody proof, PETTY-441): the same rule
    const without = applyOps(third.doc, [{ type: "remove_line", line_id: lineId }], { lineHasEntries: () => false });
    const { rev: _rev, ...noCounter } = without;
    void _rev;
    const oldDelete = await owner.call("POST", `/drawers/${d.id}/lines/${lineId}/delete`, { document: { ...sealedBody(await owner.sealDoc(d.id, d.key, noCounter, 1, 1), 1, 1), base_version: third.version, verification: false }, proof: await owner.proof() });
    expect(oldDelete.statusCode).toBe(409);
    expect(oldDelete.json().code).toBe("DocumentFormatOlder");
    const newDelete = await owner.call("POST", `/drawers/${d.id}/lines/${lineId}/delete`, { document: { ...sealedBody(await owner.sealDoc(d.id, d.key, nextRev(without), 1, 2), 1, 2), base_version: third.version, verification: false }, proof: await owner.proof() });
    expect(newDelete.statusCode).toBe(200);
    expect(await read(owner, d.id, d.key)).toMatchObject({ version: 4, schema: 2, doc: { rev: 2, lines: [] } });
  });

  it("a new drawer can start in format 2, with its counter at 1", async () => {
    const id = crypto.randomUUID();
    const { createDrawerKey } = await import("@petty/crypto");
    const { key, selfWrap } = await createDrawerKey(owner.sender, id, 1);
    const res = await owner.call("POST", "/drawers", { id, document: sealedBody(await owner.sealDoc(id, key, nextRev(withLine("New")), 1, 2), 1, 2), self_wrap: selfWrap });
    expect(res.statusCode).toBe(201);
    expect(await read(owner, id, key)).toMatchObject({ version: 1, schema: 2, doc: { rev: 1, name: "New" } });
  });

  it("the server no longer copies an earlier version into place: the owner's client writes it, with the next counter", async () => {
    const d = await owner.createDrawer("Shelf", withLine("Shelf"));
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === d.id);
    const raw = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
    const inv = await owner.call("POST", `/drawers/${d.id}/invitations`, { invitee_id: member.id, role: "write", wrap: await wrapDrawerKey(raw, owner.sender, member.user.pub.ecdh, d.id, 1) });
    expect(inv.statusCode).toBe(201);
    expect((await member.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);

    // two writes with a counter, the second one unwanted
    const v1 = await read(owner, d.id, d.key);
    expect((await write(owner, d.id, d.key, nextRev(v1.doc), v1.version, 2)).statusCode).toBe(200);
    const v2 = await read(owner, d.id, d.key);
    expect((await write(member, d.id, d.key, nextRev({ ...v2.doc, name: "Oops" }), v2.version, 2)).statusCode).toBe(200);
    const now = await read(owner, d.id, d.key);
    expect(now).toMatchObject({ version: 3, doc: { rev: 2, name: "Oops" } });

    const history = (await owner.call("GET", `/drawers/${d.id}/document/history`)).json().history as { id: string; version: number; document: { author_id: string; key_version: number; schema_version: number; nonce: string; ciphertext: string } }[];
    const kept = history.find((h) => h.version === 2)!;
    expect(kept.document.schema_version).toBe(2);

    // the old route: the owner is told that the app does this now; a member and a stranger get what they got before; nothing is written
    const body = { history_id: kept.id, base_version: now.version };
    const gone = await owner.call("POST", `/drawers/${d.id}/document/restore`, body);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ code: "RestoreByApp", context: { drawer_id: d.id } });
    expect((await member.call("POST", `/drawers/${d.id}/document/restore`, body)).statusCode).toBe(403);
    expect((await stranger.call("POST", `/drawers/${d.id}/document/restore`, body)).statusCode).toBe(404);
    expect(await read(owner, d.id, d.key)).toMatchObject({ version: 3, doc: { rev: 2, name: "Oops" } });

    // what the owner's app does instead: open the kept copy, give it the counter after the current one, save it
    const h = kept.document;
    const copy = readDocument(await openDocument(d.key, { record_type: "document", record_id: d.id, drawer_id: d.id, line_id: null, author_id: h.author_id, key_version: h.key_version, schema_version: h.schema_version }, { nonce: fromB64(h.nonce), ciphertext: fromB64(h.ciphertext) }), { schema_version: h.schema_version, version: kept.version });
    expect(copy).toMatchObject({ rev: 1, name: "Shelf" });
    expect((await write(owner, d.id, d.key, nextRev({ ...copy, rev: now.doc.rev! }), now.version, 2)).statusCode).toBe(200);
    expect(await read(member, d.id, d.key)).toMatchObject({ version: 4, schema: 2, doc: { rev: 3, name: "Shelf" } });
    // the replaced version is kept in turn, so this can be undone too
    expect((await owner.call("GET", `/drawers/${d.id}/document/history`)).json().history).toHaveLength(3);
  });
});
