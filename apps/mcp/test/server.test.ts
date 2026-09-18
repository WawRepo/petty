import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { patSecret, patToken, sealPatBundle, toB64 } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import { connect } from "@petty/agent";
import { buildApp } from "../../api/src/app.js";
import { apiPool, maintPool } from "../../api/src/db.js";
import { Client, makeJoinLink, userMaterial } from "../../api/src/devtools/fixtures.js";
import { buildServer } from "../src/server.js";

/**
 * The MCP server (PETTY-166), driven the way Claude Desktop drives it: over a transport, listing
 * tools and calling them. The API runs in memory; the token and the keys stay in this process.
 */
const app = buildApp();
const run = Math.random().toString(36).slice(2, 8);
let owner: Client;
let drawerId: string, lineId: string;

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
  const secret = patSecret();
  const id = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
  const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
  const key = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
  const bundle = await sealPatBundle(secret, id, {
    v: 1,
    user_id: owner.id,
    drawers: [{ drawer_id: drawerId, key_version: 1, key: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", key))) }],
    ...(role === "write" ? { ecdsa: toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", owner.user.keys.ecdsa.privateKey))) } : {}),
  });
  expect((await owner.call("POST", "/me/tokens", { token_id: id, name: `mcp-${role}`, role, scope: null, expires_at: null, bundle })).statusCode).toBe(201);
  return patToken(id, secret);
}

/** A client wired to the server through an in-memory transport pair, like a host would be. */
async function host(role: "read" | "write"): Promise<McpClient> {
  const server = await buildServer({
    token: await tokenFor(role),
    apiUrl: "http://petty.test",
    connect: (o) => connect({ ...o, fetch: inject }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "test-host", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const text = (res: unknown) => ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

beforeAll(async () => {
  await app.ready();
  owner = new Client(app, await userMaterial("mcp", { email: `mcp-${run}@test.local` }));
  expect((await owner.signup(await makeJoinLink())).statusCode).toBe(201);
  lineId = crypto.randomUUID();
  const doc = applyOp(newDocument("Kitchen"), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
  const made = await owner.createDrawer("Kitchen", doc);
  drawerId = made.id;
  expect((await owner.postEntry(drawerId, made.key, lineId, "add", 5000)).res.statusCode).toBe(201);
}, 120_000);

afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

describe("petty mcp (PETTY-166)", () => {
  it("offers reading tools to a read token and no writing tools", async () => {
    const client = await host("read");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["find_item", "history", "list_drawers", "list_places", "list_tags"]);
  });

  it("lists drawers with balances, labelled as data", async () => {
    const client = await host("read");
    const out = text(await client.callTool({ name: "list_drawers", arguments: {} }));
    expect(out).toContain("drawer: Kitchen");
    expect(out).toContain("item: Cash");
    expect(out).toContain("50.00 PLN");
  });

  it("finds an item by words and answers with one line", async () => {
    const client = await host("read");
    expect(text(await client.callTool({ name: "find_item", arguments: { query: "kitchen cash" } }))).toContain("item: Cash");
    const miss = await client.callTool({ name: "find_item", arguments: { query: "bicycle" } });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toContain("NotFound");
  });

  it("a write token gets add, withdraw and adjust, and the answer says the new balance", async () => {
    const client = await host("write");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "adjust", "find_item", "history", "list_drawers", "list_places", "list_tags", "move_drawer", "remove_tag", "rename_tag", "tag_item", "untag_item", "withdraw"]);

    const added = text(await client.callTool({ name: "add", arguments: { item: "kitchen cash", amount: "10", comment: "from Claude" } }));
    expect(added).toContain("is now 60.00 PLN");
    const took = text(await client.callTool({ name: "withdraw", arguments: { item: `${drawerId}/${lineId}`, amount: "20" } }));
    expect(took).toContain("is now 40.00 PLN");
    const counted = text(await client.callTool({ name: "adjust", arguments: { item: "kitchen cash", amount: "37.50", comment: "counted" } }));
    expect(counted).toContain("is now 37.50 PLN");

    const history = text(await client.callTool({ name: "history", arguments: { item: "kitchen cash" } }));
    expect(history).toContain("comment: from Claude");
  });

  it("tags and places through the tools: tag, list, filter, rename, move, list places (PETTY-174/175)", async () => {
    const client = await host("write");
    expect(text(await client.callTool({ name: "tag_item", arguments: { item: "kitchen cash", tag: "food" } }))).toContain("now has tags: food");
    expect(text(await client.callTool({ name: "list_tags", arguments: {} }))).toContain("tag: food · Kitchen: Cash");
    expect(text(await client.callTool({ name: "list_drawers", arguments: { tag: "FOOD" } }))).toContain("item: Cash");
    expect(text(await client.callTool({ name: "list_drawers", arguments: { tag: "travel" } }))).toBe("Nothing matches.");
    expect(text(await client.callTool({ name: "rename_tag", arguments: { from: "food", to: "groceries" } }))).toContain("1 item");
    expect(text(await client.callTool({ name: "move_drawer", arguments: { drawer: "Kitchen", place: "House › Pantry" } }))).toContain("House › Pantry");
    expect(text(await client.callTool({ name: "list_places", arguments: {} }))).toContain("  place: Pantry · drawers: Kitchen");
    expect(text(await client.callTool({ name: "list_drawers", arguments: { place: "house" } }))).toContain("drawer: Kitchen (House › Pantry)");
    expect(text(await client.callTool({ name: "untag_item", arguments: { item: "kitchen cash", tag: "groceries" } }))).toContain("now has tags: none");
    await client.callTool({ name: "move_drawer", arguments: { drawer: "Kitchen", place: "" } });
    expect(text(await client.callTool({ name: "list_places", arguments: {} }))).toBe("No drawer has a place yet.");
  });

  it("stays up when Petty cannot be reached at start, and each call says why (PETTY-172)", async () => {
    const token = await tokenFor("read");
    let reachable = false;
    const server = await buildServer({
      token,
      apiUrl: "http://petty.test",
      connect: (o) => connect({ ...o, fetch: (async (i: RequestInfo | URL, init?: RequestInit) => {
        if (!reachable) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EHOSTUNREACH" } });
        return inject(i, init);
      }) as typeof fetch }),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: "test-host", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const down = await client.callTool({ name: "list_drawers", arguments: {} });
    expect(down.isError).toBe(true);
    expect(text(down)).toContain("EHOSTUNREACH");
    reachable = true; // the network comes back: the next call connects and answers
    expect(text(await client.callTool({ name: "list_drawers", arguments: {} }))).toContain("drawer: Kitchen");
  });

  it("a read token cannot write, even if the host asks for the tool", async () => {
    const client = await host("read");
    const res = await client.callTool({ name: "add", arguments: { item: "kitchen cash", amount: "1" } });
    expect(res.isError).toBe(true);
    expect(text(res).toLowerCase()).toContain("tool");
  });
});
