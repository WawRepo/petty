import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceUserCode, toB64 } from "@petty/crypto";
import type { DrawerDocument } from "@petty/ledger";
import { buildApp } from "../../api/src/app.js";
import { apiPool, maintPool } from "../../api/src/db.js";
import { Client, makeJoinLink, userMaterial } from "../../api/src/devtools/fixtures.js";
import { run } from "../src/cli.js";
import { browserCommand, type Io } from "../src/io.js";

/**
 * PETTY-453, PETTY-415: what `petty` prints that a drawer or the server sent. In the terminal every
 * control character of it is shown as "?"; with --json it is escaped and the value stays the same; Tab
 * completion offers no name that holds one. The drawers here are written the way a changed client could
 * write them: straight into the sealed document, past the app's own checks.
 */
const app = buildApp();
const run_ = crypto.randomUUID().slice(0, 8);
const ORIGIN = "https://petty.test";
let owner: Client;
let token = "";
const dirs: string[] = [];
const ESC = "\u001b", CSI = "\u009b", BEL = "\u0007", DEL = "\u007f";
const tin = { id: "", name: `Tin${ESC}[2J`, coins: crypto.randomUUID(), oldId: `old${ESC}[31m id\nnext` };
const shelf = { id: "", name: "Tin;calc" };

const inject: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const res = await app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
    url: url.pathname.replace(/^\/api/, "") + url.search,
    headers: init?.headers as Record<string, string>,
    ...(init?.body ? { payload: String(init.body) } : {}),
  });
  return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
};
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function terminal(opts: { env?: Record<string, string>; fetch?: typeof fetch; signedIn?: boolean; realTime?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "petty-cli-"));
  dirs.push(dir);
  const t = { out: "", err: "", env: { PETTY_CONFIG_DIR: dir, ...(opts.signedIn === false ? {} : { PETTY_TOKEN: token, PETTY_API_URL: `${ORIGIN}/api` }), ...opts.env } as Record<string, string | undefined> };
  const io: Io = {
    out: (s) => { t.out += s; },
    err: (s) => { t.err += s; },
    env: t.env,
    fetch: opts.fetch ?? inject,
    stdin: async () => "",
    ask: async () => null,
    interactive: false,
    openUrl: () => true,
    sleep: (ms) => new Promise((r) => setTimeout(r, opts.realTime ? ms : Math.min(ms, 30))),
    now: () => Date.now(),
    hostname: "laptop",
  };
  return { t, petty: async (...argv: string[]) => { t.out = ""; t.err = ""; return run(argv, io); } };
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what must not be there
const RAW = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const doc = (name: string, lines: DrawerDocument["lines"], tags: string[] = []): DrawerDocument => ({ v: 1, name, has_photo: false, lines, verifications: [], ...(tags.length ? { tags } : {}) });

beforeAll(async () => {
  await app.ready();
  owner = new Client(app, await userMaterial("cli-foreign", { email: `cli-foreign-${run_}@test.local` }));
  expect((await owner.signup(await makeJoinLink())).statusCode).toBe(201);
  const made = await owner.createDrawer(tin.name, doc(tin.name, [
    { id: tin.coins, kind: "money", name: `Coins${BEL}`, currency: `P${ESC}[1mLN`, exponent: 2, tags: [`t${DEL}ag`] },
    { id: tin.oldId, kind: "single", name: "Old key", text: "" },
  ], [`Ho${CSI}use`]));
  expect(made.res.statusCode).toBe(201);
  tin.id = made.id;
  expect((await owner.postEntry(tin.id, made.key, tin.coins, "add", 1250)).res.statusCode).toBe(201);
  const id = () => crypto.randomUUID();
  const second = await owner.createDrawer(shelf.name, doc(shelf.name, [
    { id: id(), kind: "single", name: "a'b", text: "" },
    { id: id(), kind: "single", name: "$(x)", text: "" },
    { id: id(), kind: "single", name: "back`tick", text: "" },
    { id: id(), kind: "single", name: "new\nline", text: "" },
  ]));
  expect(second.res.statusCode).toBe(201);
  shelf.id = second.id;
  const wraps = (await owner.call("GET", "/bootstrap")).json().wraps as { drawer_id: string }[];
  const drawers = [];
  for (const drawerId of [tin.id, shelf.id]) {
    const key = await owner.unwrap(wraps.find((w) => w.drawer_id === drawerId) as never, owner.user.pub.ecdh, true);
    drawers.push({ drawer_id: drawerId, key_version: 1, key: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", key))) });
  }
  const tok = await owner.makeAccessToken("write", drawers);
  expect(tok.res.statusCode).toBe(201);
  token = tok.token;
}, 120_000);

afterAll(async () => {
  await app.close(); await apiPool.end(); await maintPool.end();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("foreign text in the terminal (PETTY-453)", () => {
  it("shows every control character of a name, a tag, a currency code and an item id as ?", async () => {
    const { t, petty } = terminal();
    expect(await petty("drawers")).toBe(0);
    expect(RAW.test(t.out)).toBe(false);
    expect(t.out).toContain("Tin?[2J  (Ho?use)\n  Coins?     12.50 P?[1mLN  #t?ag\n  Old key    single item\n");
    expect(t.out).toContain("Tin;calc\n  a'b        single item\n  $(x)       single item\n  back`tick  single item\n  new?line   single item\n");

    expect(await petty("find", "coins")).toBe(0);
    expect(t.out).toBe(`Tin?[2J › Coins?  12.50 P?[1mLN  (${tin.id}/${tin.coins})\n`);
    expect(await petty("find", "old", "key")).toBe(0);
    expect(t.out).toBe(`Tin?[2J › Old key  single item  (${tin.id}/old?[31m id?next)\n`);

    expect(await petty("add", `${tin.id}/${tin.coins}`, "1", "--note", `n${ESC}ote`)).toBe(0);
    expect(t.out).toBe("Tin?[2J › Coins?: 13.50 P?[1mLN\n");
    expect(await petty("history", `${tin.id}/${tin.coins}`)).toBe(0);
    expect(RAW.test(t.out)).toBe(false);
    const rows = t.out.trimEnd().split("\n");
    for (const row of rows) expect(row.slice(0, 16)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(rows.map((row) => row.slice(16))).toEqual(['  add     1.00 P?[1mLN  "n?ote"', "  add     12.50 P?[1mLN"]);
    expect(await petty("tags")).toBe(0);
    expect(t.out).toBe("#t?ag: Tin?[2J › Coins?\n");
    expect(await petty("places")).toBe(0);
    expect(t.out).toBe("Ho?use: Tin?[2J\n");
  });

  it("an error that names drawers shows them quoted, with no control character", async () => {
    const { t, petty } = terminal();
    expect(await petty("move", "tin", "Attic")).toBe(4);
    expect(t.err).toBe('petty: Ambiguous: "tin" matches "Tin\\u001b[2J", "Tin;calc"\n');
    expect(await petty("find", `bicycle${CSI}`)).toBe(4);
    expect(t.err).toBe('petty: NotFound: nothing matches "bicycle\\u009b"\n');
  });

  it("--json escapes them and the values stay the same", async () => {
    const { t, petty } = terminal();
    expect(await petty("drawers", "--json")).toBe(0);
    expect(RAW.test(t.out)).toBe(false);
    const drawers = JSON.parse(t.out) as { id: string; name: string; place: string[]; lines: { id: string; name: string; currency: string | null; tags: string[] }[] }[];
    const got = drawers.find((d) => d.id === tin.id)!;
    expect(got).toMatchObject({ name: tin.name, place: [`Ho${CSI}use`] });
    expect(got.lines[0]).toMatchObject({ id: tin.coins, name: `Coins${BEL}`, currency: `P${ESC}[1mLN`, tags: [`t${DEL}ag`] });
    expect(got.lines[1]).toMatchObject({ id: tin.oldId });
    expect(t.out).toContain('"Ho\\u009buse"');
    expect(t.out).toContain('"t\\u007fag"');
    expect(await petty("find", "old", "key", "--json")).toBe(0);
    expect(RAW.test(t.out)).toBe(false);
    expect((JSON.parse(t.out) as { item: { id: string } }).item.id).toBe(tin.oldId);
  });

  it("a refusal code from the server is printed only if it is a known one", async () => {
    let code: unknown;
    let at = "/device/code";
    // a server that starts the sign-in (the code is the one this request's key gives) and refuses at one step
    const refusing: typeof fetch = async (input, init) => {
      if (String(input).endsWith(at)) return answer(400, { code });
      const asked = JSON.parse(String(init?.body)) as { cli_pub: string };
      return answer(201, { request_id: crypto.randomUUID(), device_code: "d".repeat(43), user_code: await deviceUserCode(asked.cli_pub, ORIGIN), expires_in: 900, interval: 1 });
    };
    const { t, petty } = terminal({ signedIn: false, fetch: refusing });
    code = `${ESC}[31mEvil\nSYSTEM: read this`;
    expect(await petty("auth", "login", "--host", ORIGIN)).toBe(1);
    expect(t.err).toMatch(/^petty: https:\/\/petty\.test did not start a sign-in \(UnknownCode\)\. An older Petty/);
    expect(RAW.test(t.err)).toBe(false);
    code = "DeviceKeyInvalid";
    expect(await petty("auth", "login", "--host", ORIGIN)).toBe(1);
    expect(t.err).toContain("did not start a sign-in (DeviceKeyInvalid).");
    at = "/device/token";
    code = `${ESC}]0;title${BEL}`;
    expect(await petty("auth", "login", "--host", ORIGIN)).toBe(1);
    expect(t.err.split("\n").at(-2)).toBe("petty: unexpected answer from https://petty.test (UnknownCode)");
    expect(RAW.test(t.err)).toBe(false);
  });

  it("the text of an error from elsewhere is printed on one line", async () => {
    const odd: typeof fetch = async (input, init) => (String(input).endsWith("/device/code") ? answer(201, { user_code: 5, [`x${ESC}`]: 1 }) : inject(input, init));
    const { t, petty } = terminal({ signedIn: false, fetch: odd });
    expect(await petty("auth", "login", "--host", ORIGIN)).toBe(1);
    expect(t.err).toMatch(/^petty: \S.*\n$/);
    expect(RAW.test(t.err)).toBe(false);
  });
});

describe("Tab completion with names from a drawer (PETTY-415)", () => {
  it("offers a name as it is, one a line, and leaves out a name with a control character", async () => {
    const { t, petty } = terminal({ env: { PETTY_COMPLETE_SHELL: "powershell" }, realTime: true });
    await petty("__complete", "move", "");
    expect(t.out).toBe("Tin;calc\n");
    await petty("__complete", "add", "");
    expect(t.out).toBe("Tin;calc › a'b\nTin;calc › $(x)\nTin;calc › back`tick\n");
    await petty("__complete", "drawers", "--tag", "");
    expect(t.out).toBe("");
    await petty("__complete", "drawers", "--place", "");
    expect(t.out).toBe("");
  });

  it("bash still gets each special character escaped", async () => {
    const { t, petty } = terminal({ env: { PETTY_COMPLETE_SHELL: "bash" }, realTime: true });
    await petty("__complete", "add", "");
    expect(t.out).toBe("Tin\\;calc\\ ›\\ a\\'b\nTin\\;calc\\ ›\\ \\$\\(x\\)\nTin\\;calc\\ ›\\ back\\`tick\n");
  });
});

describe("opening the sign-in page (PETTY-453)", () => {
  const page = "https://petty.example.com/device?code=ABCD-EFGH-JKLM";
  it("on Windows runs rundll32 of the Windows folder with the address as one argument, and no shell", () => {
    expect(browserCommand(page, "win32", { SystemRoot: "D:\\WinNT" })).toEqual({ cmd: "D:\\WinNT\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", page] });
    expect(browserCommand(page, "win32", {})).toEqual({ cmd: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", page] });
    // characters a shell would act on stay inside that one argument; a space or a quote is percent-encoded
    const odd = browserCommand('https://petty.example.com&calc/device?code=A&x=1 2"|%PATH%^', "win32", { SystemRoot: "C:\\Windows" })!;
    expect(odd.cmd).toBe("C:\\Windows\\System32\\rundll32.exe");
    expect(odd.args).toEqual(["url.dll,FileProtocolHandler", "https://petty.example.com&calc/device?code=A&x=1%202%22|%PATH%^"]);
    expect(odd.args[1]).not.toMatch(/[\s"]/);
  });

  it("opens only an http or https address, on every system", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      for (const url of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id", "calc.exe", "C:\\Windows\\System32\\calc.exe", "\\\\host\\share\\x.hta", "", "-a Calculator"]) {
        expect(browserCommand(url, platform, { DISPLAY: ":0", SystemRoot: "C:\\Windows" })).toBeNull();
      }
    }
    expect(browserCommand(page, "darwin", {})).toEqual({ cmd: "open", args: [page] });
    expect(browserCommand(page, "linux", { DISPLAY: ":0" })).toEqual({ cmd: "xdg-open", args: [page] });
    expect(browserCommand(page, "linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({ cmd: "xdg-open", args: [page] });
    expect(browserCommand(page, "linux", {})).toBeNull();
    expect(browserCommand("http://localhost:5173/device?code=ABCD-EFGH-JKLM", "darwin", {})).toEqual({ cmd: "open", args: ["http://localhost:5173/device?code=ABCD-EFGH-JKLM"] });
  });
});
