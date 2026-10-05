import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceUserCode, sealDeviceToken, toB64 } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import type { Client } from "../../../apps/api/src/devtools/fixtures.js";
import { API, ORIGIN, newUser } from "../lib.js";

/**
 * PETTY-274: the command line as it ships. The image serves /downloads/petty.mjs; this test downloads
 * that file and runs it against the stack over HTTP. `petty auth login` asks, the person allows it (the
 * web page's steps, done here through the API: check the code against the tool's key, make a token,
 * seal it to the tool), and the downloaded program then reads and writes with it.
 */
const dir = mkdtempSync(join(tmpdir(), "petty-it-cli-"));
const cli = join(dir, "petty.mjs");
let ann: Client;
let drawerId: string, lineId: string, raw: string;

function petty(args: string[], stdin?: string) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, PETTY_CONFIG_DIR: dir, PETTY_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"] });
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
  expect((await ann.postEntry(drawerId, made.key, lineId, "add", 2500)).res.statusCode).toBe(201);
  const wrap = (await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
  raw = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", await ann.unwrap(wrap, ann.user.pub.ecdh, true))));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("petty, the shipped command line (PETTY-274)", () => {
  it("signs in through the device flow, reads and writes, and ends its token on logout", async () => {
    const login = petty(["auth", "login", "--host", ORIGIN, "--no-browser"]);
    await expect.poll(login.err, { timeout: 30_000 }).toMatch(/code: [A-Z]{4}-[A-Z]{4}-[A-Z]{4}/);
    const code = /code: ([A-Z]{4}-[A-Z]{4}-[A-Z]{4})/.exec(login.err())![1]!;
    // PETTY-322: the address follows the code in a write of its own; the v1.5.12 upgrade run read in between
    await expect.poll(login.err, { timeout: 5_000 }).toContain(`${ORIGIN}/device?code=${code}`);

    // the page's part: find the request, check the code is the tool's key's, make a token, seal it to the tool
    const view = (await ann.call("GET", `/device/${code}`)).json();
    expect(await deviceUserCode(view.cli_pub)).toBe(code);
    const tok = await ann.makeAccessToken("write", [{ drawer_id: drawerId, key_version: 1, key: raw }]);
    const sealed = await sealDeviceToken(view.cli_pub, tok.token, { requestId: view.id, userCode: code, origin: ORIGIN });
    expect((await ann.call("POST", `/device/${code}/approve`, { sealed })).statusCode).toBe(204);
    expect(await login.done).toBe(0);
    expect(login.err()).toContain(`Signed in to ${ORIGIN}`);
    expect(statSync(join(dir, "hosts.json")).mode & 0o777).toBe(0o600);

    const list = petty(["drawers", "--json"]);
    expect(await list.done).toBe(0);
    expect(JSON.parse(list.out())).toMatchObject([{ id: drawerId, name: "Garage box", lines: [{ id: lineId, amount: "25.00 EUR" }] }]);

    const add = petty(["add", "Garage box › Cash", "1.50", "--note", "-"], "from the shipped CLI");
    expect(await add.done).toBe(0);
    expect(add.out()).toBe("Garage box › Cash: 26.50 EUR\n");

    const logout = petty(["auth", "logout"]);
    expect(await logout.done).toBe(0);
    expect((await fetch(`${API}/me/token`, { headers: { authorization: `Bearer ${tok.bearer}` } })).status).toBe(401);
  });

  it("signs in with a token on stdin, for scripts", async () => {
    const tok = await ann.makeAccessToken("read", [{ drawer_id: drawerId, key_version: 1, key: raw }]);
    const login = petty(["auth", "login", "--host", ORIGIN, "--with-token"], `${tok.token}\n`);
    expect(await login.done).toBe(0);
    const find = petty(["find", "garage", "cash"]);
    expect(await find.done).toBe(0);
    expect(find.out()).toContain("Garage box › Cash  26.50 EUR");
    const write = petty(["take", "Garage box › Cash", "1"]);
    expect(await write.done).toBe(3); // read only
  });
});
