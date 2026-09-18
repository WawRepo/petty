import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { patSecret, patToken, sealPatBundle, toB64, wrapDrawerKey } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import { buildApp } from "../../../apps/api/src/app.js";
import { apiPool, maintPool } from "../../../apps/api/src/db.js";
import { Client, makeJoinLink, userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
import { connect, TokenError, type AgentClient } from "../src/index.js";

/**
 * The headless client (PETTY-165) against the real API, in memory. It holds the token, opens the
 * bundle here, decrypts what the bundle covers, and appends entries the owner signs.
 */
const app = buildApp();
const run = Math.random().toString(36).slice(2, 8);
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

/** A token made the way the web app makes one: its own ECDH pair, the public half on the server. */
async function tokenAndId(role: "read" | "write"): Promise<{ token: string; id: string; pair: CryptoKeyPair; pub: string }> {
  const secret = patSecret();
  const id = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
  const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
  const extractable = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
  const raw = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", extractable)));
  const ecdsa = toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", owner.user.keys.ecdsa.privateKey)));
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const bundle = await sealPatBundle(secret, id, {
    v: 1,
    user_id: owner.id,
    drawers: [{ drawer_id: drawerId, key_version: 1, key: raw }],
    ecdh: toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    ...(role === "write" ? { ecdsa } : {}),
  });
  const res = await owner.call("POST", "/me/tokens", { token_id: id, ecdh_pub: pub, name: `agent-${role}`, role, scope: null, expires_at: null, bundle });
  expect(res.statusCode).toBe(201);
  return { token: patToken(id, secret), id: res.json().id as string, pair, pub };
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

const client = async (role: "read" | "write"): Promise<AgentClient> => connect({ token: await tokenFor(role), apiUrl: "http://petty.test", fetch: inject });

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
    expect(res.amount).toBe("20.50 PLN");
    const after = (await c.drawers())[0]!.lines[0]!;
    expect(after.balance).toBe(2050);
    // and the owner sees it in the history, as their own entry
    const history = await c.history(drawerId, lineId);
    expect(history[0]!.comment).toBe("from the agent");
    expect(history[0]!.mine).toBe(true);
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
    const c = await connect({ token, apiUrl: "http://petty.test", fetch: inject });
    const list = (await owner.call("GET", "/me/tokens")).json().tokens as { id: string; name: string }[];
    const mine = list.find((t) => t.name === "agent-read")!;
    expect((await owner.call("DELETE", `/me/tokens/${mine.id}`)).statusCode).toBe(204);
    await expect(c.drawers()).rejects.toMatchObject({ code: "TokenRevoked" });

    const other = patToken(token.split(".")[0]!.replace("petty_pat_", ""), patSecret());
    await expect(connect({ token: other, apiUrl: "http://petty.test", fetch: inject })).rejects.toBeInstanceOf(Error);
  });

  it("a drawer made after the token reaches it once the owner's app wraps the key (PETTY-169)", async () => {
    const made = await tokenAndId("read");
    const client = await connect({ token: made.token, apiUrl: "http://petty.test", fetch: inject });
    expect((await client.drawers()).map((d) => d.name)).toEqual(["Kitchen"]);

    // the owner makes a new drawer
    const laterLine = crypto.randomUUID();
    const doc = applyOp(newDocument("Attic"), { type: "add_line", line: { id: laterLine, kind: "money", name: "Tin", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const attic = await owner.createDrawer("Attic", doc);
    expect(attic.res.statusCode).toBe(201);
    // the token cannot see it yet
    const before = await connect({ token: made.token, apiUrl: "http://petty.test", fetch: inject });
    expect((await before.drawers()).map((d) => d.name)).toEqual(["Kitchen"]);

    // the owner's app wraps the new drawer key for the token, as syncTokenWraps does
    const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === attic.id);
    const key = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
    const forToken = await wrapDrawerKey(key, { ecdhPrivate: owner.user.keys.ecdh.privateKey, ecdhPublicB64: owner.user.pub.ecdh }, made.pub, attic.id, 1);
    expect((await owner.call("POST", `/me/tokens/${made.id}/keys`, { keys: [{ drawer_id: attic.id, key_version: 1, wrap: forToken }] })).statusCode).toBe(204);

    // now it does
    const after = await connect({ token: made.token, apiUrl: "http://petty.test", fetch: inject });
    expect((await after.drawers()).map((d) => d.name).sort()).toEqual(["Attic", "Kitchen"]);
  });

  it("a token cannot reach a drawer outside its bundle", async () => {
    const c = await client("write");
    await expect(c.history(crypto.randomUUID(), lineId)).rejects.toBeInstanceOf(TokenError);
  });
});
