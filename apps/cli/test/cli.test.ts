import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceUserCode, patSecret, patToken, sealDeviceToken, sealPatBundle, toB64 } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import { buildApp } from "../../api/src/app.js";
import { apiPool, maintPool } from "../../api/src/db.js";
import { Client, makeJoinLink, userMaterial } from "../../api/src/devtools/fixtures.js";
import { run } from "../src/cli.js";
import { unquotePowerShell } from "../src/complete.js";
import type { Io } from "../src/io.js";
import { fakeKeychain } from "./fake-keychain.js";

/**
 * `petty`, driven the way a person drives it (PETTY-274): the real API runs in memory, `petty auth login`
 * prints its code and "opens" the page, and the test plays the person on that page — it signs in as the
 * owner, checks the code against the tool's key, makes a token and seals it to the tool, as the web app does.
 */
const app = buildApp();
const run_ = crypto.randomUUID().slice(0, 8);
const ORIGIN = "https://petty.test";
let owner: Client;
let drawerId: string, lineId: string;
const dirs: string[] = [];

/** What `petty auth login` last sent to start a sign-in. */
let asked: { cli_pub: string; user_code: string } | null = null;

/** The API behind https://petty.test/api, in memory. */
const inject: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/device/code") asked = JSON.parse(String(init?.body)) as { cli_pub: string; user_code: string };
  const res = await app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
    url: url.pathname.replace(/^\/api/, "") + url.search,
    headers: init?.headers as Record<string, string>,
    ...(init?.body ? { payload: String(init.body) } : {}),
  });
  return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
};

/**
 * A made-up terminal: what the program printed, and a person who acts on the page it opened. The token
 * stays in the file (PETTY_TOKEN_STORE=file) unless a test says otherwise: a test never reaches the
 * keychain of the computer it runs on.
 */
function terminal(opts: { stdin?: string; onPage?: (url: string) => Promise<void>; env?: Record<string, string>; realTime?: boolean; platform?: NodeJS.Platform } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "petty-cli-"));
  dirs.push(dir);
  const t = { out: "", err: "", pages: [] as string[], env: { PETTY_CONFIG_DIR: dir, PETTY_TOKEN_STORE: "file", ...opts.env } as Record<string, string | undefined>, dir };
  const io: Io = {
    out: (s) => { t.out += s; },
    err: (s) => { t.err += s; },
    env: t.env,
    fetch: inject,
    stdin: async () => opts.stdin ?? "",
    ask: async () => null,
    interactive: false,
    openUrl: (url) => { t.pages.push(url); if (opts.onPage) void opts.onPage(url); return true; },
    // waits are cut to 30 ms (device-login polling); live completion keeps its real 1.5 s window, or a
    // busy machine misses it and completes nothing (flaky in CI, PETTY-303)
    sleep: (ms) => new Promise((r) => setTimeout(r, opts.realTime ? ms : Math.min(ms, 30))),
    now: () => Date.now(),
    hostname: "laptop",
    platform: opts.platform ?? process.platform,
  };
  return { t, io, petty: (...argv: string[]) => run(argv, io) };
}

/** A token the way the web app makes one: the drawer's key copied into a bundle sealed by the token's secret. */
async function webToken(role: "read" | "write", scope: string[] | null = null): Promise<string> {
  const secret = patSecret();
  const id = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
  const wrap = (await owner.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
  const key = await owner.unwrap(wrap, owner.user.pub.ecdh, true);
  const signing = role === "write" ? await owner.tokenSigning() : null;
  const bundle = await sealPatBundle(secret, id, {
    v: 1, user_id: owner.id,
    drawers: [{ drawer_id: drawerId, key_version: 1, key: toB64(new Uint8Array(await crypto.subtle.exportKey("raw", key))) }],
    ...(signing ? signing.bundle : {}),
  });
  const res = await owner.call("POST", "/me/tokens", { token_id: id, name: "petty on laptop", role, scope, expires_at: null, bundle, proof: await owner.proof(), ...(signing ? { signing: signing.body } : {}) });
  expect(res.statusCode).toBe(201);
  return patToken(id, secret);
}

/** The person on /device: the page finds the request, checks the code, makes the token and seals it to the tool. */
const allow = (role: "read" | "write") => async (url: string) => {
  const code = new URL(url).searchParams.get("code")!;
  const view = (await owner.call("GET", `/device/${code}`)).json();
  expect(await deviceUserCode(view.cli_pub, ORIGIN)).toBe(code);
  const sealed = await sealDeviceToken(view.cli_pub, await webToken(role), { requestId: view.id, userCode: code, origin: ORIGIN });
  expect((await owner.call("POST", `/device/${code}/approve`, { sealed })).statusCode).toBe(204);
};

beforeAll(async () => {
  await app.ready();
  owner = new Client(app, await userMaterial("cli", { email: `cli-${run_}@test.local` }));
  expect((await owner.signup(await makeJoinLink())).statusCode).toBe(201);
  lineId = crypto.randomUUID();
  const doc = applyOp(newDocument("Kitchen"), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
  const made = await owner.createDrawer("Kitchen", doc);
  drawerId = made.id;
  expect((await owner.postEntry(drawerId, made.key, lineId, "add", 5000)).res.statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  await app.close(); await apiPool.end(); await maintPool.end();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("petty auth login through the page (PETTY-274)", () => {
  it("prints a code, opens the page, and once it is allowed there, reads and writes the drawers", async () => {
    const { t, petty } = terminal({ onPage: allow("write") });
    expect(await petty("auth", "login", "--host", "petty.test")).toBe(0);
    const code = /Your one-time code: ([A-Z]{4}(?:-[A-Z]{4}){4})\n/.exec(t.err)?.[1];
    expect(code).toBeTruthy();
    // PETTY-451: the code is the tool's own, from its key and the address it signs in to; another address gives another
    expect(asked!.user_code).toBe(code);
    expect(code).toBe(await deviceUserCode(asked!.cli_pub, ORIGIN));
    expect(code).not.toBe(await deviceUserCode(asked!.cli_pub, "https://petty.example"));
    expect(t.pages).toEqual([`${ORIGIN}/device?code=${code}`]);
    expect(t.err).toContain("Signed in to https://petty.test with the token “petty on laptop” (may add entries)");
    // kept for this user only, never with drawer content
    const file = join(t.dir, "hosts.json");
    const fd = openSync(file, "r");
    expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    expect(statSync(t.dir).mode & 0o777).toBe(0o700);
    const stored = readFileSync(fd, "utf8");
    closeSync(fd);
    expect(stored).toContain("petty_pat_");
    expect(stored).not.toContain("Kitchen");

    t.out = "";
    expect(await petty("drawers", "--json")).toBe(0);
    const drawers = JSON.parse(t.out);
    expect(drawers[0]).toMatchObject({ id: drawerId, name: "Kitchen", lines: [{ id: lineId, name: "Cash", amount: "50.00 PLN" }] });

    t.out = "";
    expect(await petty("add", "Kitchen › Cash", "10.50", "--note", "from the terminal")).toBe(0);
    expect(t.out).toBe("Kitchen › Cash: 60.50 PLN\n");
    t.out = "";
    expect(await petty("take", "kitchen cash", "0.50")).toBe(0);
    expect(t.out).toBe("Kitchen › Cash: 60.00 PLN\n");
    t.out = "";
    expect(await petty("history", `${drawerId}/${lineId}`, "--json")).toBe(0);
    expect(JSON.parse(t.out).map((e: { comment: string }) => e.comment)).toContain("from the terminal");

    t.out = "";
    expect(await petty("auth", "status", "--json")).toBe(0);
    expect(JSON.parse(t.out)).toMatchObject([{ host: ORIGIN, token: "petty on laptop", role: "write", works: true, scope: "all", drawers: ["Kitchen"] }]);

    // logout ends the token on the server too
    const token = JSON.parse(stored).hosts[ORIGIN].token as string;
    expect(await petty("auth", "logout")).toBe(0);
    expect(t.err).toContain("is ended there and forgotten here");
    expect((await app.inject({ method: "GET", url: "/me/token", headers: { authorization: `Bearer ${token.split(".")[0]}` } })).statusCode).toBe(401);
    expect(await petty("drawers")).toBe(3);
    expect(t.err).toContain("not signed in");
  });

  it("stops when the person denies it on the page", async () => {
    const { t, petty } = terminal({
      onPage: async (url) => { expect((await owner.call("POST", `/device/${new URL(url).searchParams.get("code")}/deny`)).statusCode).toBe(204); },
    });
    expect(await petty("auth", "login", "--host", ORIGIN, "--read-only")).toBe(3);
    expect(t.err).toContain("denied on the page");
  });

  /** A server that answers the sign-in request in its own way. The real one is not asked: it counts requests per address. */
  const answering = (status: number, body: Record<string, unknown>): typeof fetch => async (input, init) =>
    String(input).endsWith("/device/code") ? new Response(JSON.stringify(body), { status }) : inject(input, init);
  const started = (userCode: string) => ({ request_id: crypto.randomUUID(), device_code: "d".repeat(43), user_code: userCode, expires_in: 900, interval: 5 });

  it("refuses a code that is not its own (a server that swapped the key)", async () => {
    const { t, io } = terminal();
    expect(await run(["auth", "login", "--host", ORIGIN], { ...io, fetch: answering(201, started("BCDF-GHJK-LMNP-QRST-VWXZ")) })).toBe(1);
    expect(t.err).toContain("not this request's");
    expect(t.pages).toEqual([]);
  });

  // PETTY-451: the earlier 12-letter form is never used, whatever the server answers
  it("stops at a Petty that still answers with the earlier 12-letter code, and says that it is older", async () => {
    const { t, io } = terminal();
    // what a Petty from before PETTY-451 does: it ignores the tool's code and answers with its own, shorter one
    expect(await run(["auth", "login", "--host", ORIGIN], { ...io, fetch: answering(201, started("BCDF-GHJK-LMNP")) })).toBe(1);
    expect(t.err).toContain("https://petty.test runs an older Petty than this command line");
    // PETTY-515: a Petty that says no release version (this one is "dev") gets its page with the commands
    expect(t.err).toContain("the page https://petty.test/ai shows how to install it");
    expect(t.err).not.toContain("Your one-time code");
    expect(t.pages).toEqual([]);
  });

  it("says so when the Petty finds this command line too old, and names the file of that Petty's release (PETTY-515)", async () => {
    const { t, io } = terminal();
    const newer: typeof fetch = async (input, init) =>
      String(input).endsWith("/api/config") ? new Response(JSON.stringify({ auth: "local", version: "v9.8.7" }), { status: 200 }) : answering(400, { code: "CommandLineTooOld", message: "this command line is older than this Petty" })(input, init);
    expect(await run(["auth", "login", "--host", ORIGIN], { ...io, fetch: newer })).toBe(1);
    expect(t.err).toMatch(/this petty \(v\d+\.\d+\.\d+\) is older than the Petty at https:\/\/petty\.test/);
    expect(t.err).toContain("download the petty of v9.8.7: https://github.com/WawRepo/petty/releases/download/v9.8.7/petty.mjs (the page https://petty.test/ai shows how to install it)");
    expect(t.pages).toEqual([]);
  });

  it("signs in with a token from stdin, and a read-only token may not write", async () => {
    const { t, petty } = terminal({ stdin: `${await webToken("read")}\n` });
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    expect(t.err).toContain("(read only)");
    expect(await petty("add", "Kitchen › Cash", "1")).toBe(3);
    expect(t.err).toContain("ReadOnly");
  });

  it("uses PETTY_TOKEN when it is set, for scripts", async () => {
    const { t, petty } = terminal({ env: { PETTY_TOKEN: await webToken("read"), PETTY_API_URL: `${ORIGIN}/api` } });
    expect(await petty("find", "kitchen", "cash")).toBe(0);
    expect(t.out).toContain("Kitchen › Cash  60.00 PLN");
    // PETTY-461: status says which drawers the token opens
    t.out = "";
    expect(await petty("auth", "status")).toBe(0);
    expect(t.out).toContain("read only\n  opens every drawer, also new ones: “Kitchen”\n");
  });

  it("answers usage mistakes with exit code 2 and an unknown item with 4", async () => {
    const { t, petty } = terminal({ env: { PETTY_TOKEN: await webToken("read"), PETTY_API_URL: `${ORIGIN}/api` } });
    expect(await petty("frobnicate")).toBe(2);
    expect(await petty("add", "Kitchen › Cash")).toBe(2);
    expect(t.err).toContain("missing <amount>");
    expect(await petty("drawers", "--nope")).toBe(2);
    expect(await petty("find", "bicycle")).toBe(4);
    expect(t.err).toContain("NotFound");
    expect(t.err).not.toContain("this token opens only");
  });

  // PETTY-452: the page now makes tokens for chosen drawers
  it("with a token made for chosen drawers: says so at sign-in, lists only those, and says why another is not found", async () => {
    const outLine = crypto.randomUUID();
    const doc = applyOp(newDocument("Strongbox"), { type: "add_line", line: { id: outLine, kind: "money", name: "Gold", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const outside = await owner.createDrawer("Strongbox", doc);
    const { t, petty } = terminal({ stdin: `${await webToken("write", [drawerId])}\n` });
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    expect(t.err).toContain("It opens only the 1 drawer chosen for it.");
    expect(await petty("drawers", "--json")).toBe(0);
    expect(JSON.parse(t.out).map((d: { name: string }) => d.name)).toEqual(["Kitchen"]);
    t.out = "";
    expect(await petty("auth", "status")).toBe(0);
    expect(t.out).toContain("  opens chosen drawers only: “Kitchen”\n");
    expect(t.out).not.toContain("Strongbox");
    const why = "(this token opens only the 1 drawer chosen for it)";
    for (const argv of [["find", "strongbox", "gold"], ["add", "Strongbox › Gold", "1"], ["history", `${outside.id}/${outLine}`], ["move", "Strongbox", "Home"]]) {
      t.err = "";
      expect(await petty(...argv), argv.join(" ")).toBe(4);
      expect(t.err, argv.join(" ")).toContain("NotFound");
      expect(t.err, argv.join(" ")).toContain(why);
    }
    // what it does open still works, also named by its page in the app (PETTY-515)
    t.out = "";
    expect(await petty("find", "kitchen", "cash")).toBe(0);
    expect(t.out).toContain("Kitchen › Cash");
    t.out = "";
    expect(await petty("history", `${ORIGIN}/drawers/${drawerId}/lines/${lineId}`, "--json")).toBe(0);
    expect(JSON.parse(t.out).length).toBeGreaterThan(0);
    expect(await petty("history", `${ORIGIN}/drawers/${drawerId}`)).toBe(2);
    expect(t.err).toContain("is a drawer's page");
  });
});

describe("the token in the system's keychain (PETTY-276)", () => {
  const fake = fakeKeychain();
  const empty = mkdtempSync(join(tmpdir(), "petty-nopath-"));
  afterAll(() => { fake.remove(); rmSync(empty, { recursive: true, force: true }); });
  const KEY = `petty ${ORIGIN}`;
  const NAME = { darwin: "the macOS keychain", linux: "the keyring (Secret Service)" } as const;
  /** A terminal on that system, with the stand-in keychain tools first on the PATH. */
  const at = (platform: "darwin" | "linux", stdin?: string, env: Record<string, string> = {}) => terminal({ platform, ...(stdin ? { stdin } : {}), env: { PETTY_TOKEN_STORE: "", PATH: fake.path, ...env } });
  const hosts = (dir: string) => JSON.parse(readFileSync(join(dir, "hosts.json"), "utf8")) as { default: string; hosts: Record<string, { token?: string; token_in?: string; name: string }> };
  const notes = (err: string) => err.match(/petty: note: /g)?.length ?? 0;
  const noTokenOnACommandLine = () => { for (const argv of fake.argv()) expect(argv.join(" ")).not.toContain("petty_pat_"); };

  it.each(["darwin", "linux"] as const)("on %s: sign-in keeps the token there, the file only says so; status, commands and logout use it", async (platform) => {
    fake.clear();
    const token = await webToken("write");
    const { t, petty } = at(platform, `${token}\n`);
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    expect(t.err).toContain(`(may add entries). Kept in ${NAME[platform]}.\n`);
    expect(notes(t.err)).toBe(0);
    expect(fake.store()).toEqual({ [KEY]: token });
    expect(readFileSync(join(t.dir, "hosts.json"), "utf8")).not.toContain("petty_pat_");
    expect(hosts(t.dir).hosts[ORIGIN]).toEqual({ token_in: "keychain", name: "petty on laptop", role: "write", user_id: owner.id, added_at: expect.any(String) });

    t.out = "";
    expect(await petty("drawers", "--json")).toBe(0);
    expect(JSON.parse(t.out)[0]).toMatchObject({ id: drawerId, name: "Kitchen" });
    t.out = "";
    expect(await petty("auth", "status")).toBe(0);
    expect(t.out).toContain(`  token kept in ${NAME[platform]}\n`);
    t.out = "";
    expect(await petty("auth", "status", "--json")).toBe(0);
    expect(JSON.parse(t.out)).toMatchObject([{ host: ORIGIN, works: true, from: "keychain" }]);
    t.out = "";
    expect(await petty("auth", "token")).toBe(0);
    expect(t.out).toBe(`${token}\n`);
    noTokenOnACommandLine();

    expect(await petty("auth", "logout")).toBe(0);
    expect(t.err).toContain("is ended there and forgotten here");
    expect(fake.store()).toEqual({});
    expect(hosts(t.dir).hosts).toEqual({});
    expect((await app.inject({ method: "GET", url: "/me/token", headers: { authorization: `Bearer ${token.split(".")[0]}` } })).statusCode).toBe(401);
  });

  it("moves a token an older petty left in the file on its first read, not on a Tab press", async () => {
    fake.clear();
    const token = await webToken("read");
    const { t, petty } = at("linux", undefined, { PETTY_COMPLETE_SHELL: "bash" });
    writeFileSync(join(t.dir, "hosts.json"), JSON.stringify({ default: ORIGIN, hosts: { [ORIGIN]: { token, name: "petty on laptop", role: "read", user_id: owner.id, added_at: "2026-11-01T00:00:00.000Z" } } }), { mode: 0o600 });
    // Tab completion reads the token from the file and leaves it there
    expect(await petty("__complete", "add", "Ki")).toBe(0);
    expect(fake.argv()).toEqual([]);
    expect(hosts(t.dir).hosts[ORIGIN]!.token).toBe(token);

    t.out = "";
    expect(await petty("find", "kitchen", "cash")).toBe(0);
    expect(t.out).toContain("Kitchen › Cash");
    expect(t.err).toBe(`petty: the token for ${ORIGIN} moved from ${join(t.dir, "hosts.json")} to the keyring (Secret Service).\n`);
    expect(fake.store()).toEqual({ [KEY]: token });
    expect(hosts(t.dir).hosts[ORIGIN]).toEqual({ token_in: "keychain", name: "petty on laptop", role: "read", user_id: owner.id, added_at: "2026-11-01T00:00:00.000Z" });
    t.err = "";
    expect(await petty("find", "kitchen", "cash")).toBe(0);
    expect(t.err).toBe("");
    noTokenOnACommandLine();
  });

  it("a keychain that fails: the token stays in the file with one note; PETTY_TOKEN_STORE=file keeps it there quietly", async () => {
    fake.clear();
    fake.mode("broken");
    const token = await webToken("read");
    const { t, petty } = at("darwin", `${token}\n`);
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    const file = join(t.dir, "hosts.json");
    expect(t.err).toContain(`petty: note: the macOS keychain did not take the token (SecKeychainSearchCopyNext: User interaction is not allowed.); it is kept in ${file} instead. PETTY_TOKEN_STORE=file keeps it there without this note.\n`);
    expect(notes(t.err)).toBe(1);
    expect(t.err).toContain(`Kept in ${file}.\n`);
    expect(hosts(t.dir).hosts[ORIGIN]!.token).toBe(token);

    // each read tries the move again, says so once, and works from the file
    t.err = "";
    expect(await petty("find", "kitchen", "cash")).toBe(0);
    expect(notes(t.err)).toBe(1);
    expect(t.err).toContain(`could not move to the macOS keychain`);
    expect(hosts(t.dir).hosts[ORIGIN]!.token).toBe(token);

    t.err = "";
    t.env["PETTY_TOKEN_STORE"] = "file";
    const calls = fake.argv().length;
    expect(await petty("find", "kitchen", "cash")).toBe(0);
    expect(t.err).toBe("");
    expect(fake.argv()).toHaveLength(calls);
  });

  it("a keychain that takes the token but does not give it back: the file keeps it", async () => {
    fake.clear();
    fake.mode("lossy");
    const token = await webToken("read");
    const { t, petty } = at("linux", `${token}\n`);
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    expect(t.err).toContain("did not take the token (it gave back another token)");
    expect(hosts(t.dir).hosts[ORIGIN]!.token).toBe(token);
  });

  it("a token in a keychain that is locked, or lost its entry: exit 3 and what to do; the login stays for later", async () => {
    fake.clear();
    const token = await webToken("read");
    const { t, petty } = at("linux", `${token}\n`);
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    fake.mode("broken");
    t.err = "";
    expect(await petty("drawers")).toBe(3);
    expect(t.err).toBe(`petty: the keyring (Secret Service) did not give the token for ${ORIGIN} (Cannot autolaunch D-Bus without X11 $DISPLAY). Unlock it and try again, or run petty auth login --host ${ORIGIN}\n`);
    t.out = "";
    expect(await petty("auth", "status", "--json")).toBe(3);
    expect(JSON.parse(t.out)).toMatchObject([{ host: ORIGIN, works: false, from: "keychain" }]);
    expect(hosts(t.dir).hosts[ORIGIN]!.token_in).toBe("keychain");

    fake.mode("ok"); // unlocked
    expect(await petty("drawers")).toBe(0);

    rmSync(join(fake.dir, "store.json")); // the entry deleted in the keyring's own app
    t.err = "";
    expect(await petty("drawers")).toBe(3);
    expect(t.err).toContain(`the keyring (Secret Service) has no token for ${ORIGIN} any more: run petty auth login --host ${ORIGIN}`);
  });

  it("logout with a locked keychain forgets the login here and says what is left to do", async () => {
    fake.clear();
    const token = await webToken("read");
    const { t, petty } = at("darwin", `${token}\n`);
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    fake.mode("broken");
    t.err = "";
    expect(await petty("auth", "logout")).toBe(0);
    expect(t.err).toContain("Forgotten here, but the keychain did not give the token to end it at https://petty.test: revoke “petty on laptop” in Settings → Access tokens.");
    expect(t.err).toContain(`petty: note: the macOS keychain did not remove the token (SecKeychainSearchCopyNext: User interaction is not allowed.): delete its entry for ${ORIGIN} there by hand`);
    expect(hosts(t.dir).hosts).toEqual({});
  });

  it("PETTY_TOKEN_STORE=file: a new sign-in goes to the file and the keychain's earlier entry is removed; a wrong value stops before a sign-in", async () => {
    fake.clear();
    const first = at("linux", `${await webToken("read")}\n`);
    expect(await first.petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    expect(Object.keys(fake.store())).toEqual([KEY]);
    const second = await webToken("read");
    const { t, petty } = at("linux", `${second}\n`, { PETTY_CONFIG_DIR: first.t.dir, PETTY_TOKEN_STORE: "file" });
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    expect(t.err).toContain(`Kept in ${join(first.t.dir, "hosts.json")}.`);
    expect(hosts(first.t.dir).hosts[ORIGIN]!.token).toBe(second);
    expect(fake.store()).toEqual({});

    const typo = at("linux", undefined, { PETTY_TOKEN_STORE: "keyring" });
    expect(await typo.petty("auth", "login", "--host", ORIGIN)).toBe(2);
    expect(typo.t.err).toBe('petty: PETTY_TOKEN_STORE takes "file" or "auto", not "keyring"\n');
    expect(typo.t.pages).toEqual([]);
  });

  it("no keychain tool on this computer: the file, without a note", async () => {
    const { t, petty } = at("linux", `${await webToken("read")}\n`, { PATH: empty });
    expect(await petty("auth", "login", "--host", ORIGIN, "--with-token")).toBe(0);
    expect(notes(t.err)).toBe(0);
    expect(t.err).toContain(`Kept in ${join(t.dir, "hosts.json")}.`);
    expect(hosts(t.dir).hosts[ORIGIN]!.token).toMatch(/^petty_pat_/);
  });
});

describe("what a load could not check reaches the person (PETTY-445)", () => {
  /** The API as a changed database would serve it: the newest entry of Cash comes with another row's ciphertext. */
  const damaged: typeof fetch = async (input, init) => {
    const res = await inject(input, init);
    if (new URL(String(input)).pathname !== "/api/me/token/bootstrap") return res;
    const boot = (await res.json()) as { entries: { line_id: string; ciphertext: string }[] };
    const rows = boot.entries.filter((e) => e.line_id === lineId);
    rows.at(-1)!.ciphertext = rows[0]!.ciphertext;
    return new Response(JSON.stringify(boot), { status: 200, headers: { "content-type": "application/json" } });
  };

  it("says on stderr, once per run, that an entry did not open; the answer still comes, and --json counts it", async () => {
    const { t, io } = terminal({ env: { PETTY_TOKEN: await webToken("read"), PETTY_API_URL: `${ORIGIN}/api` } });
    const petty = (...argv: string[]) => run(argv, { ...io, fetch: damaged });
    expect(await petty("find", "kitchen", "cash")).toBe(0); // find loads the drawers more than once
    expect(t.out).toContain("Kitchen › Cash  ");
    expect(t.err.match(/petty: warning: /g)).toHaveLength(1);
    expect(t.err).toContain('petty: warning: drawer "Kitchen" / item "Cash": 1 entry could not be opened; left out of the balance\n');
    t.out = "";
    expect(await petty("drawers", "--json")).toBe(0);
    expect(JSON.parse(t.out)[0].lines[0]).toMatchObject({ name: "Cash", unreadable: 1, unverified: 0, chain: "ok" });
  });

  it("says nothing when everything checks out", async () => {
    const { t, petty } = terminal({ env: { PETTY_TOKEN: await webToken("read"), PETTY_API_URL: `${ORIGIN}/api` } });
    expect(await petty("drawers")).toBe(0);
    expect(t.err).toBe("");
  });
});

describe("Tab completion (PETTY-274)", () => {
  it("completes commands, flags and values without a login", async () => {
    const { t, petty } = terminal();
    expect(await petty("__complete", "au")).toBe(0);
    expect(t.out).toBe("auth\n");
    t.out = "";
    await petty("__complete", "auth", "");
    expect(t.out.split("\n").filter(Boolean)).toEqual(["login", "status", "logout", "token"]);
    t.out = "";
    await petty("__complete", "auth", "login", "--exp");
    expect(t.out).toBe("--expires\n");
    t.out = "";
    await petty("__complete", "auth", "login", "--expires", "");
    expect(t.out).toBe("30\n90\n365\nnever\n");
    t.out = "";
    await petty("__complete", "completion", "-s", "f");
    expect(t.out).toBe("fish\n");
  });

  it("completes item names live, decrypted in memory, quoted for bash", async () => {
    const { t, petty } = terminal({ env: { PETTY_TOKEN: await webToken("read"), PETTY_API_URL: `${ORIGIN}/api`, PETTY_COMPLETE_SHELL: "bash" }, realTime: true });
    await petty("__complete", "add", "Ki");
    expect(t.out).toBe("Kitchen\\ ›\\ Cash\n");
    t.out = "";
    // what bash passes back for a word already completed is unescaped before it is used
    await petty("__complete", "add", "Kitchen\\ ›\\ Cash", "");
    expect(t.out).toBe("");
    t.out = "";
    t.env["PETTY_COMPLETE_NAMES"] = "0";
    await petty("__complete", "add", "Ki");
    expect(t.out).toBe("");
  });

  it("PowerShell: the word being typed keeps its quotes, the words before it come as values (PETTY-493)", async () => {
    const w = terminal({ env: { PETTY_TOKEN: await webToken("write"), PETTY_API_URL: `${ORIGIN}/api` } });
    expect(await w.petty("tag", "Kitchen › Cash", "garden")).toBe(0);
    try {
      const { t, petty } = terminal({ env: { PETTY_TOKEN: await webToken("read"), PETTY_API_URL: `${ORIGIN}/api`, PETTY_COMPLETE_SHELL: "powershell", PETTY_COMPLETE_CURRENT: "='Ki'" }, realTime: true });
      await petty("__complete", "add");
      expect(t.out).toBe("Kitchen › Cash\n");
      // the next word after a quoted one: PowerShell sends that word's value, which is taken as it is
      t.out = "";
      t.env["PETTY_COMPLETE_CURRENT"] = "=";
      await petty("__complete", "untag", "Kitchen › Cash");
      expect(t.out).toBe("garden\n");
      t.out = "";
      t.env["PETTY_COMPLETE_CURRENT"] = '="ga';
      await petty("__complete", "untag", "Kitchen › Cash");
      expect(t.out).toBe("garden\n");
    } finally {
      expect(await w.petty("untag", "Kitchen › Cash", "garden")).toBe(0);
    }
  });

  it("PowerShell: reads the word being typed as PowerShell does (PETTY-493)", () => {
    expect(unquotePowerShell("'Kit")).toBe("Kit");
    expect(unquotePowerShell("'Kit'")).toBe("Kit");
    expect(unquotePowerShell("'a''b")).toBe("a'b");
    expect(unquotePowerShell("\u2018a\u2019\u2019b")).toBe("a\u2019b");
    expect(unquotePowerShell('"Shed `"box"')).toBe('Shed "box');
    expect(unquotePowerShell('"a""b')).toBe('a"b');
    expect(unquotePowerShell("'back`tick'")).toBe("back`tick");
    expect(unquotePowerShell("Kit`chen")).toBe("Kitchen");
    expect(unquotePowerShell("a\\b")).toBe("a\\b");
    expect(unquotePowerShell("")).toBe("");
  });

  it("prints a script for each shell, and refuses another", async () => {
    const { t, petty } = terminal();
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      t.out = "";
      expect(await petty("completion", "-s", shell)).toBe(0);
      expect(t.out).toContain("petty __complete");
    }
    expect(await petty("completion", "-s", "tcsh")).toBe(2);
  });
});
