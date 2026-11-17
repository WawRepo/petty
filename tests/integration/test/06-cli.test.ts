import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceUserCode, fromB64, hashEntry, openEntryUnverified, sealDeviceToken, toB64 } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import type { Client } from "../../../apps/api/src/devtools/fixtures.js";
import { fakeKeychain } from "../../../apps/cli/test/fake-keychain.js";
import { API, ORIGIN, compose, newUser } from "../lib.js";

/**
 * PETTY-274: the command line as it ships. The image serves /downloads/petty.mjs; this test downloads
 * that file and runs it against the stack over HTTP. `petty auth login` asks, the person allows it (the
 * web page's steps, done here through the API: check the code against the tool's key and this site's
 * address, make a token, seal it to the tool), and the downloaded program then reads and writes with it.
 * PETTY-451: the code has 20 letters; a request without one (an older command line) is told to update.
 * PETTY-452: a token for chosen drawers reads those only.
 * PETTY-276: the token goes to the system's keychain; these runs keep it in the file
 * (PETTY_TOKEN_STORE=file), so a test never reaches the keychain of the computer it runs on, except
 * the one test that gives the program stand-ins of the keychain tools.
 */
const dir = mkdtempSync(join(tmpdir(), "petty-it-cli-"));
const cli = join(dir, "petty.mjs");
let ann: Client;
let drawerId: string, lineId: string, raw: string, key: CryptoKey;

function petty(args: string[], stdin?: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, PETTY_CONFIG_DIR: dir, PETTY_TOKEN: "", PETTY_TOKEN_STORE: "file", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  child.stdin.end(stdin ?? "");
  const done = new Promise<number>((r) => child.on("close", (code) => r(code ?? -1)));
  return { done, out: () => out, err: () => err };
}

beforeAll(async () => {
  const res = await fetch(`${ORIGIN}/downloads/petty.mjs`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
  writeFileSync(cli, text, { mode: 0o755 });

  ann = await newUser("cli");
  lineId = crypto.randomUUID();
  const doc = applyOp(newDocument("Garage box"), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "EUR", exponent: 2 } }, { lineHasEntries: () => false });
  const made = await ann.createDrawer("Garage box", doc);
  drawerId = made.id;
  key = made.key;
  expect((await ann.postEntry(drawerId, made.key, lineId, "add", 2500)).res.statusCode).toBe(201);
  const wrap = (await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
  raw = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", await ann.unwrap(wrap, ann.user.pub.ecdh, true))));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("petty, the shipped command line (PETTY-274)", () => {
  it("signs in through the device flow, reads and writes, and ends its token on logout", async () => {
    const login = petty(["auth", "login", "--host", ORIGIN, "--no-browser"]);
    await expect.poll(login.err, { timeout: 30_000 }).toMatch(/code: [A-Z]{4}(-[A-Z]{4}){4}\n/);
    const code = /code: ([A-Z]{4}(?:-[A-Z]{4}){4})\n/.exec(login.err())![1]!;
    // PETTY-322: the address follows the code in a write of its own; the v1.5.12 upgrade run read in between
    await expect.poll(login.err, { timeout: 5_000 }).toContain(`${ORIGIN}/device?code=${code}`);

    // the page's part: find the request, check the code is the tool's key's at this address, make a token, seal it to the tool
    const view = (await ann.call("GET", `/device/${code}`)).json();
    expect(await deviceUserCode(view.cli_pub, ORIGIN)).toBe(code);
    expect(await deviceUserCode(view.cli_pub, "https://petty.example")).not.toBe(code);
    const tok = await ann.makeAccessToken("write", [{ drawer_id: drawerId, key_version: 1, key: raw }]);
    const sealed = await sealDeviceToken(view.cli_pub, tok.token, { requestId: view.id, userCode: code, origin: ORIGIN });
    expect((await ann.call("POST", `/device/${code}/approve`, { sealed })).statusCode).toBe(204);
    expect(await login.done).toBe(0);
    // PETTY-461: the request log names the route, never the code that was waiting for approval
    const log = () => compose("logs --no-color --no-log-prefix app");
    await expect.poll(log, { timeout: 10_000 }).toContain('"url":"/api/device/:code/approve"');
    expect(log()).not.toContain(code);
    expect(login.err()).toContain(`Signed in to ${ORIGIN}`);
    expect(statSync(join(dir, "hosts.json")).mode & 0o777).toBe(0o600);

    const list = petty(["drawers", "--json"]);
    expect(await list.done).toBe(0);
    expect(JSON.parse(list.out())).toMatchObject([{ id: drawerId, name: "Garage box", lines: [{ id: lineId, amount: "25.00 EUR" }] }]);

    const add = petty(["add", "Garage box › Cash", "1.50", "--note", "-"], "from the shipped CLI");
    expect(await add.done).toBe(0);
    expect(add.out()).toBe("Garage box › Cash: 26.50 EUR\n");
    // PETTY-445: the shipped program links its entry to the one before it, as the web app does, and says
    // nothing about a drawer whose history checks out
    expect(add.err()).not.toContain("warning");
    const rows = (await ann.call("GET", `/drawers/${drawerId}/lines/${lineId}/entries`)).json().entries as { id: string; author_id: string; key_version: number; schema_version: number; nonce: string; ciphertext: string }[];
    const [newest, first] = await Promise.all(rows.map((r) => openEntryUnverified(key, { record_type: "entry", record_id: r.id, drawer_id: drawerId, line_id: lineId, author_id: r.author_id, key_version: r.key_version, schema_version: r.schema_version }, { nonce: fromB64(r.nonce), ciphertext: fromB64(r.ciphertext) })));
    expect(rows).toHaveLength(2);
    expect(newest!.prev_hash).toBe(await hashEntry(first!));

    const logout = petty(["auth", "logout"]);
    expect(await logout.done).toBe(0);
    expect((await fetch(`${API}/me/token`, { headers: { authorization: `Bearer ${tok.bearer}` } })).status).toBe(401);
  });

  it("tells a command line that sends no code of its own to update, and starts no sign-in for it (PETTY-451)", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const cliPub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    // what `petty auth login` sent before the 20-letter code; from addresses that 08-proxy, which counts
    // its own up to the limit, never draws (PETTY-468)
    const res = await fetch(`${API}/device/code`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${210 + Math.floor(Math.random() * 45)}` },
      body: JSON.stringify({ cli_pub: cliPub, client_name: "petty on it-older", role: "read", expires_days: 30 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; user_code?: string };
    expect(body.code).toBe("CommandLineTooOld");
    expect(body.user_code).toBeUndefined();
    // and a code of the earlier form opens no request on the page's side
    expect((await ann.call("GET", "/device/BCDF-GHJK-LMNP")).statusCode).toBe(404);
  });

  it("with a token for one drawer, reads that drawer only and says why another is not found (PETTY-452)", async () => {
    const other = await ann.createDrawer("Loft chest", applyOp(newDocument("Loft chest"), { type: "add_line", line: { id: crypto.randomUUID(), kind: "money", name: "Coins", currency: "EUR", exponent: 2 } }, { lineHasEntries: () => false }));
    expect(other.res.statusCode).toBe(201);
    const tok = await ann.makeAccessToken("read", [{ drawer_id: drawerId, key_version: 1, key: raw }], [drawerId]);
    const login = petty(["auth", "login", "--host", ORIGIN, "--with-token"], `${tok.token}\n`);
    expect(await login.done).toBe(0);
    expect(login.err()).toContain("It opens only the 1 drawer chosen for it.");
    const list = petty(["drawers", "--json"]);
    expect(await list.done).toBe(0);
    expect((JSON.parse(list.out()) as { name: string }[]).map((d) => d.name)).toEqual(["Garage box"]);
    const find = petty(["find", "loft", "coins"]);
    expect(await find.done).toBe(4);
    expect(find.err()).toContain("(this token opens only the 1 drawer chosen for it)");
    // PETTY-461: status names what the token opens, and nothing else
    const status = petty(["auth", "status", "--json"]);
    expect(await status.done).toBe(0);
    expect(JSON.parse(status.out())).toMatchObject([{ works: true, scope: "chosen", drawers: ["Garage box"] }]);
    expect((await fetch(`${API}/drawers/${other.id}`, { headers: { authorization: `Bearer ${tok.bearer}` } })).status).toBe(403);
  });

  it("signs in with a token on stdin, for scripts", async () => {
    const tok = await ann.makeAccessToken("read", [{ drawer_id: drawerId, key_version: 1, key: raw }]);
    const login = petty(["auth", "login", "--host", ORIGIN, "--with-token"], `${tok.token}\n`);
    expect(await login.done).toBe(0);
    const find = petty(["find", "garage", "cash"]);
    expect(await find.done).toBe(0);
    expect(find.out()).toContain("Garage box › Cash  26.50 EUR");
    // PETTY-515: also by the item's page in the app, as the browser's address bar shows it
    const page = petty(["find", `${ORIGIN}/drawers/${drawerId}/lines/${lineId}`]);
    expect(await page.done).toBe(0);
    expect(page.out()).toContain("Garage box › Cash  26.50 EUR");
    const write = petty(["take", "Garage box › Cash", "1"]);
    expect(await write.done).toBe(3); // read only
  });

  // the shipped program with stand-ins of `security` (macOS) and `secret-tool` (Linux) first on the PATH
  // (apps/cli/test/fake-keychain.ts): it runs whichever this system has, never with the token as an argument
  it.skipIf(process.platform === "win32")("keeps the token in the keychain, and hosts.json only says so (PETTY-276)", async () => {
    const fake = fakeKeychain();
    const own = mkdtempSync(join(tmpdir(), "petty-it-keychain-"));
    try {
      const env = { PETTY_CONFIG_DIR: own, PETTY_TOKEN_STORE: "", PATH: fake.path };
      const tok = await ann.makeAccessToken("read", [{ drawer_id: drawerId, key_version: 1, key: raw }]);
      const login = petty(["auth", "login", "--host", ORIGIN, "--with-token"], `${tok.token}\n`, env);
      expect(await login.done).toBe(0);
      expect(login.err()).toMatch(/Kept in the (macOS keychain|keyring \(Secret Service\))\.\n/);
      expect(Object.values(fake.store())).toEqual([tok.token]);
      const file = readFileSync(join(own, "hosts.json"), "utf8");
      expect(file).not.toContain("petty_pat_");
      expect(JSON.parse(file).hosts[ORIGIN]).toMatchObject({ token_in: "keychain", role: "read" });

      const find = petty(["find", "garage", "cash"], undefined, env);
      expect(await find.done).toBe(0);
      expect(find.out()).toContain("Garage box › Cash");
      const status = petty(["auth", "status", "--json"], undefined, env);
      expect(await status.done).toBe(0);
      expect(JSON.parse(status.out())).toMatchObject([{ host: ORIGIN, works: true, from: "keychain" }]);
      const logout = petty(["auth", "logout"], undefined, env);
      expect(await logout.done).toBe(0);
      expect(fake.store()).toEqual({});
      expect((await fetch(`${API}/me/token`, { headers: { authorization: `Bearer ${tok.bearer}` } })).status).toBe(401);
      for (const argv of fake.argv()) expect(argv.join(" ")).not.toContain("petty_pat_");
    } finally {
      fake.remove();
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("shows text from a drawer with its control characters as ?, and escaped with --json; amounts line up after emoji (PETTY-453, PETTY-493, PETTY-495)", async () => {
    // a drawer written past the app's checks, as a changed client could write it
    const ESC = "\u001b", RLO = "\u202e";
    const coins = crypto.randomUUID();
    const odd = {
      v: 1 as const, name: `Odd${ESC}[2J box`, has_photo: false, verifications: [],
      lines: [
        { id: coins, kind: "money" as const, name: "Coins", currency: `E${ESC}UR`, exponent: 2 }, { id: `old${ESC} id`, kind: "single" as const, name: "Key", text: "" },
        // PETTY-493: a direction override, which would turn the rest of the line around in a terminal
        { id: crypto.randomUUID(), kind: "single" as const, name: `Lid${RLO}`, text: "" },
        // PETTY-495: 15 terminal cells (5 letters, 5 emoji of 2) in 15 UTF-16 units and 10 code points
        { id: crypto.randomUUID(), kind: "single" as const, name: "Pets \u{1F408}\u{1F408}\u{1F408}\u{1F408}\u{1F408}", text: "" },
      ],
    };
    const made = await ann.createDrawer(odd.name, odd);
    expect(made.res.statusCode).toBe(201);
    expect((await ann.postEntry(made.id, made.key, coins, "add", 500)).res.statusCode).toBe(201);
    const wrap = (await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === made.id);
    const key = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", await ann.unwrap(wrap, ann.user.pub.ecdh, true))));
    const tok = await ann.makeAccessToken("read", [{ drawer_id: made.id, key_version: 1, key }]);
    expect(await petty(["auth", "login", "--host", ORIGIN, "--with-token"], `${tok.token}\n`).done).toBe(0);

    const list = petty(["drawers"]);
    expect(await list.done).toBe(0);
    // every amount starts in column 20: the widest name (15 cells) and 2 spaces; before PETTY-495 the
    // emoji row was padded by code points and ran into its amount ("Pets 🐈🐈🐈🐈🐈single item")
    const row = (name: string, cellsWide: number, amount: string) => `  ${name}${" ".repeat(17 - cellsWide)}${amount}\n`;
    expect(list.out()).toBe(`Odd?[2J box\n${row("Coins", 5, "5.00 E?UR")}${row("Key", 3, "single item")}${row("Lid?", 4, "single item")}${row(odd.lines[3]!.name, 15, "single item")}`);
    const find = petty(["find", "odd", "key"]);
    expect(await find.done).toBe(0);
    expect(find.out()).toBe(`Odd?[2J box › Key  single item  (${made.id}/old? id)\n`);
    // PETTY-515: an older item id, not a UUID, names its item like any id --json prints
    const byId = petty(["find", `${made.id}/old${ESC} id`]);
    expect(await byId.done).toBe(0);
    expect(byId.out()).toContain("Odd?[2J box › Key");
    const json = petty(["drawers", "--json"]);
    expect(await json.done).toBe(0);
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must not be there
    expect(json.out()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
    expect(json.out()).toContain('"Lid\\u202e"');
    expect(JSON.parse(json.out())).toMatchObject([{ id: made.id, name: odd.name, lines: [{ id: coins, currency: `E${ESC}UR`, amount: `5.00 E${ESC}UR` }, { id: `old${ESC} id` }, { name: `Lid${RLO}` }, { name: odd.lines[3]!.name }] }]);
  });

  it("says nothing about an entry written from a view older than the latest count, and still reports a link to nothing (PETTY-500)", async () => {
    const float = crypto.randomUUID();
    const doc = applyOp(newDocument("Till"), { type: "add_line", line: { id: float, kind: "money", name: "Float", currency: "EUR", exponent: 2 } }, { lineHasEntries: () => false });
    const made = await ann.createDrawer("Till", doc);
    expect(made.res.statusCode).toBe(201);
    const first = await ann.postEntry(made.id, made.key, float, "add", 1000);
    const second = await ann.postEntry(made.id, made.key, float, "add", 200, { prev_hash: await hashEntry(first.signed) });
    expect((await ann.postEntry(made.id, made.key, float, "adjust", 1100, { prev_hash: await hashEntry(second.signed), expected_head_seq: 2, delta_hint: -100 })).res.statusCode).toBe(201);
    // written on a screen that still showed only the first entry: its link points before the count
    expect((await ann.postEntry(made.id, made.key, float, "withdraw", -300, { prev_hash: await hashEntry(first.signed) })).res.statusCode).toBe(201);
    const wrap = (await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === made.id);
    const raw = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", await ann.unwrap(wrap, ann.user.pub.ecdh, true))));
    const tok = await ann.makeAccessToken("read", [{ drawer_id: made.id, key_version: 1, key: raw }]);
    expect(await petty(["auth", "login", "--host", ORIGIN, "--with-token"], `${tok.token}\n`).done).toBe(0);
    const list = petty(["drawers"]);
    expect(await list.done).toBe(0);
    expect(list.out()).toContain(" 8.00 EUR\n");
    expect(list.err()).not.toContain("warning");
    // an entry whose link points at no row at all is still reported
    expect((await ann.postEntry(made.id, made.key, float, "add", 100, { prev_hash: "0".repeat(64) })).res.statusCode).toBe(201);
    const again = petty(["drawers"]);
    expect(await again.done).toBe(0);
    expect(again.out()).toContain(" 9.00 EUR\n");
    expect(again.err()).toContain("the history links do not match");
  });
});
