import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromB64, openDocument, patSecret, patToken, sealPatBundle, toB64 } from "@petty/crypto";
import { applyOp, newDocument, nextRev, REV_AHEAD_MAX, type DrawerDocument } from "@petty/ledger";
import { buildApp } from "../../../apps/api/src/app.js";
import { apiPool, maintPool } from "../../../apps/api/src/db.js";
import { Client, makeJoinLink, sealedBody, userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
import { connect, type AgentClient } from "../src/index.js";

/**
 * PETTY-422: the counter inside a drawer document, as a tool with an access token meets it. Against the real
 * API, in memory.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
let owner: Client;

beforeAll(async () => {
  await app.ready();
  owner = new Client(app, await userMaterial("agent-rev", { email: `agent-rev-${run}@test.local` }));
  expect((await owner.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);

afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

type Fetch = typeof fetch;
const inject: Fetch = async (input, init) => {
  const url = new URL(String(input));
  const res = await app.inject({ method: (init?.method ?? "GET") as "GET" | "POST", url: url.pathname + url.search, headers: init?.headers as Record<string, string>, ...(init?.body ? { payload: String(init.body) } : {}) });
  return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
};

/** A drawer of the owner with one item, and a write token that holds its key. `doc` and `schemaVersion`: how its document is stored. */
async function drawerAndTool(name: string, over: (doc: DrawerDocument) => DrawerDocument = (d) => d, schemaVersion = 1, viaFetch: Fetch = inject) {
  const lineId = crypto.randomUUID();
  const doc = applyOp(newDocument(name), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
  const made = await owner.createDrawer(name, doc);
  expect(made.res.statusCode).toBe(201);
  if (schemaVersion !== 1 || over(doc) !== doc) expect((await put(made.id, made.key, over(doc), 1, schemaVersion)).statusCode).toBe(200);
  const raw = await owner.unwrap((await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === made.id), owner.user.pub.ecdh, true);
  const secret = patSecret();
  const tokenId = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
  const signing = await owner.tokenSigning();
  const bundle = await sealPatBundle(secret, tokenId, { v: 1, user_id: owner.id, drawers: [{ drawer_id: made.id, key_version: 1, key: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", raw))) }], ...signing.bundle });
  expect((await owner.call("POST", "/me/tokens", { token_id: tokenId, name: "tool", role: "write", scope: [made.id], expires_at: null, bundle, proof: await owner.proof(), signing: signing.body })).statusCode).toBe(201);
  const tool: AgentClient = await connect({ token: patToken(tokenId, secret), apiUrl: "https://petty.test", fetch: viaFetch });
  return { id: made.id, key: made.key, lineId, tool };
}
/** The owner saves a document in the given format. */
async function put(drawerId: string, key: CryptoKey, doc: DrawerDocument, baseVersion: number, schemaVersion: number, claimed = schemaVersion) {
  return owner.call("PUT", `/drawers/${drawerId}/document`, { ...sealedBody(await owner.sealDoc(drawerId, key, doc, 1, schemaVersion), 1, claimed), base_version: baseVersion, verification: false });
}
/** The stored document, opened with the drawer key under the format its row names. */
async function stored(drawerId: string, key: CryptoKey) {
  const got = (await owner.call("GET", `/drawers/${drawerId}`)).json();
  const d = got.document;
  const doc = (await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) })) as DrawerDocument;
  return { version: got.drawer.version as number, schema: d.schema_version as number, doc };
}

describe("a tool and the counter of a drawer document", () => {
  it("a document from before the counter stays as it is: the tool adds no counter and keeps its format", async () => {
    const d = await drawerAndTool("Before");
    await d.tool.moveDrawer(d.id, ["Shed"]);
    await d.tool.tagItem(d.id, d.lineId, "cash");
    const now = await stored(d.id, d.key);
    expect(now).toMatchObject({ version: 3, schema: 1, doc: { tags: ["Shed"] } });
    expect("rev" in now.doc).toBe(false);
    expect((await d.tool.drawers()).map((x) => x.name)).toEqual(["Before"]);
  });

  it("a document with a counter is saved with the counter that was read plus one, in the same format", async () => {
    const d = await drawerAndTool("Counted", (doc) => ({ ...doc, rev: 1 }), 2);
    expect(await stored(d.id, d.key)).toMatchObject({ version: 2, schema: 2, doc: { rev: 1 } });
    await d.tool.moveDrawer(d.id, ["Shed"]);
    expect(await stored(d.id, d.key)).toMatchObject({ version: 3, schema: 2, doc: { rev: 2, tags: ["Shed"] } });
    await d.tool.addItem(d.id, { kind: "countable", name: "Batteries", unit: "pcs" });
    expect(await stored(d.id, d.key)).toMatchObject({ version: 4, schema: 2, doc: { rev: 3 } });
    expect((await d.tool.drawers())[0]!.lines.map((l) => l.name)).toEqual(["Cash", "Batteries"]);
  });

  it("when someone saves in between, the tool reads again and takes the counter from the fresh copy", async () => {
    let raced = false;
    let target: { id: string; key: CryptoKey } | null = null;
    // the owner saves a change of their own just before the tool's first save arrives
    const racing: Fetch = async (input, init) => {
      if (target && !raced && init?.method === "PUT" && String(input).endsWith(`/drawers/${target.id}/document`)) {
        raced = true;
        const cur = await stored(target.id, target.key);
        expect((await put(target.id, target.key, nextRev({ ...cur.doc, name: "Renamed" }), cur.version, 2)).statusCode).toBe(200);
      }
      return inject(input, init);
    };
    const d = await drawerAndTool("Raced", (doc) => ({ ...doc, rev: 5 }), 2, racing);
    target = d;
    await d.tool.moveDrawer(d.id, ["Shed"]);
    expect(raced).toBe(true);
    // rev 5 as read first; the owner stored 6; the tool's second attempt stored 7 on top of it
    expect(await stored(d.id, d.key)).toMatchObject({ version: 4, schema: 2, doc: { rev: 7, name: "Renamed", tags: ["Shed"] } });
  });

  it("a document that its format does not allow is left out and not written over: no counter in format 2, a counter far ahead, a newer format", async () => {
    // what a person sees: the drawer is not in the list, and a command that names it finds nothing
    const none = await drawerAndTool("No counter", (doc) => doc, 2);
    expect(await none.tool.drawers()).toEqual([]);
    await expect(none.tool.moveDrawer(none.id, ["Shed"])).rejects.toMatchObject({ code: "NotFound" });
    await expect(none.tool.mutate(none.id, [{ type: "set_tags", tags: ["Shed"] }])).rejects.toThrow(/bad_document/);
    expect((await stored(none.id, none.key)).version).toBe(2);

    const ahead = await drawerAndTool("Far ahead", (doc) => ({ ...doc, rev: 2 + REV_AHEAD_MAX + 1 }), 2);
    expect(await ahead.tool.drawers()).toEqual([]);
    await expect(ahead.tool.mutate(ahead.id, [{ type: "set_tags", tags: ["Shed"] }])).rejects.toThrow(/bad_document/);
    expect((await stored(ahead.id, ahead.key)).version).toBe(2);

    // a row that names format 3, as a later Petty might write: this build does not know it
    const newer = await drawerAndTool("Newer");
    expect((await put(newer.id, newer.key, { ...(await stored(newer.id, newer.key)).doc, rev: 1 }, 1, 2, 3)).statusCode).toBe(200);
    expect(await newer.tool.drawers()).toEqual([]);
    await expect(newer.tool.moveDrawer(newer.id, ["Shed"])).rejects.toMatchObject({ code: "NotFound" });
    await expect(newer.tool.mutate(newer.id, [{ type: "set_tags", tags: ["Shed"] }])).rejects.toMatchObject({ code: "UnknownSchemaVersion" });
    expect((await owner.call("GET", `/drawers/${newer.id}`)).json().drawer.version).toBe(2);
  });
});
