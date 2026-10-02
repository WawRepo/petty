import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceUserCode, patSecret, patToken, sealDeviceToken, sealPatBundle, toB64 } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import { buildApp } from "../../api/src/app.js";
import { apiPool, maintPool } from "../../api/src/db.js";
import { Client, makeJoinLink, userMaterial } from "../../api/src/devtools/fixtures.js";
import { run } from "../src/cli.js";
import type { Io } from "../src/io.js";

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

/** The API behind https://petty.test/api, in memory. */
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

/** A made-up terminal: what the program printed, and a person who acts on the page it opened. */
function terminal(opts: { stdin?: string; onPage?: (url: string) => Promise<void>; env?: Record<string, string>; realTime?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "petty-cli-"));
  dirs.push(dir);
  const t = { out: "", err: "", pages: [] as string[], env: { PETTY_CONFIG_DIR: dir, ...opts.env } as Record<string, string | undefined>, dir };
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
  };
  return { t, io, petty: (...argv: string[]) => run(argv, io) };
}

/** A token the way the web app makes one: the drawer's key copied into a bundle sealed by the token's secret. */
async function webToken(role: "read" | "write"): Promise<string> {
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
  const res = await owner.call("POST", "/me/tokens", { token_id: id, name: "petty on laptop", role, scope: null, expires_at: null, bundle, proof: await owner.proof(), ...(signing ? { signing: signing.body } : {}) });
  expect(res.statusCode).toBe(201);
  return patToken(id, secret);
}

/** The person on /device: the page finds the request, checks the code, makes the token and seals it to the tool. */
const allow = (role: "read" | "write") => async (url: string) => {
  const code = new URL(url).searchParams.get("code")!;
  const view = (await owner.call("GET", `/device/${code}`)).json();
  expect(await deviceUserCode(view.cli_pub)).toBe(code);
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
    const code = /Your one-time code: ([A-Z]{4}-[A-Z]{4}-[A-Z]{4})/.exec(t.err)?.[1];
    expect(code).toBeTruthy();
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
    expect(JSON.parse(t.out)).toMatchObject([{ host: ORIGIN, token: "petty on laptop", role: "write", works: true }]);

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

  it("refuses a code that is not derived from its own key (a server that swapped the key)", async () => {
    const { t, io } = terminal();
    const swapped: typeof fetch = async (input, init) => {
      const res = await inject(input, init);
      if (!String(input).endsWith("/device/code")) return res;
      const body = await res.json();
      return new Response(JSON.stringify({ ...body, user_code: "BCDF-GHJK-LMNP" }), { status: res.status });
    };
    expect(await run(["auth", "login", "--host", ORIGIN], { ...io, fetch: swapped })).toBe(1);
    expect(t.err).toContain("not this request's");
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
  });

  it("answers usage mistakes with exit code 2 and an unknown item with 4", async () => {
    const { t, petty } = terminal({ env: { PETTY_TOKEN: await webToken("read"), PETTY_API_URL: `${ORIGIN}/api` } });
    expect(await petty("frobnicate")).toBe(2);
    expect(await petty("add", "Kitchen › Cash")).toBe(2);
    expect(t.err).toContain("missing <amount>");
    expect(await petty("drawers", "--nope")).toBe(2);
    expect(await petty("find", "bicycle")).toBe(4);
    expect(t.err).toContain("NotFound");
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
