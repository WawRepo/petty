import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { API, ORIGIN, compose, testEnv } from "../lib.js";

/** The deployment itself: the stack as the compose file ships it (PETTY-160, PETTY-190). */
describe("deployment", () => {
  it("is healthy, and the migrations ran in their own one-shot service", async () => {
    expect(await (await fetch(`${API}/health`)).json()).toEqual({ ok: true, db: "up" });
    expect((await fetch(`${API}/health/live`)).status).toBe(200);
    const ps = compose("ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}'");
    expect(ps).toMatch(/^migrate exited 0$/m);
    expect(ps).toMatch(/^app running 0$/m);
  });

  it("the app cannot change its files or gain rights; /tmp stays writable (PETTY-420)", () => {
    // the migrations above ran under the same settings (x-petty-hardening in the compose file)
    const status = compose("exec -T app cat /proc/1/status");
    expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
    expect(status).toMatch(/^CapBnd:\s+0+$/m); // no capability can come back
    const write = (path: string) => compose(`exec -T app sh -c "touch ${path} 2>/dev/null && echo written || echo refused"`).trim();
    expect(write("/home/node/petty-it")).toBe("refused"); // the node user's own home: read-only file system
    expect(write("/tmp/petty-it")).toBe("written");
    expect(compose("exec -T app cat /sys/fs/cgroup/pids.max").trim()).toBe("256");
  });

  it("health probes are not logged, other requests are (PETTY-240)", async () => {
    for (let i = 0; i < 3; i++) { await fetch(`${API}/health/live`); await fetch(`${API}/health`); }
    expect((await fetch(`${API}/config`)).status).toBe(200);
    const loggedRoutes = () => compose("logs --no-color --no-log-prefix app").split("\n")
      .filter((l) => l.includes('"msg":"request"'))
      .map((l) => (JSON.parse(l.slice(l.indexOf("{"))) as { route: string }).route);
    await expect.poll(loggedRoutes, { timeout: 10_000 }).toContain("/api/config"); // request logging works
    expect(loggedRoutes().filter((r) => r.startsWith("/api/health"))).toEqual([]);
  });

  it("the app never holds the database owner password (PETTY-190)", () => {
    const env = compose("exec -T app env");
    expect(env).not.toContain(testEnv("OWNER_DB_PASSWORD"));
    expect(env).not.toMatch(/^DATABASE_URL=/m);
    expect(env).toMatch(/^API_DATABASE_URL=/m);
  });

  it("the image's pnpm is the one package.json names (PETTY-388)", () => {
    const { packageManager } = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as { packageManager: string };
    expect(`pnpm@${compose("exec -T app pnpm --version").trim()}`).toBe(packageManager);
  });

  it("entries are append-only for the request role (rule 8)", () => {
    const url = `postgres://petty_api:${testEnv("API_DB_PASSWORD")}@localhost:5432/petty`;
    for (const sql of ["update entries set seq = seq", "delete from entries"]) {
      let out = "";
      try { compose(`exec -T db psql "${url}" -v ON_ERROR_STOP=1 -c "${sql}"`); } catch (e) { out = String((e as { stderr?: string }).stderr ?? e); }
      expect(out, sql).toMatch(/permission denied/);
    }
  });

  it("serves the web app with the strict headers, and the add-on", async () => {
    const page = await fetch(`${ORIGIN}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<div id=\"root\"");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    // PETTY-404: only clerk mode allows its bot check on the sign-in pages; local mode has one policy everywhere
    for (const p of ["/login", "/join?x=1"]) expect((await fetch(`${ORIGIN}${p}`)).headers.get("content-security-policy"), p).toBe(csp);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("strict-transport-security")).toBeTruthy();
    const addon = await fetch(`${ORIGIN}/downloads/petty.mcpb`);
    expect(addon.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(await addon.arrayBuffer()).slice(0, 2))).toBe("PK");
    // PETTY-173: the program for other AI apps, and the page that explains it (an app route)
    const mjs = await fetch(`${ORIGIN}/downloads/petty-mcp.mjs`);
    expect(mjs.status).toBe(200);
    const program = await mjs.text();
    expect(program.length).toBeGreaterThan(100_000);
    expect((await fetch(`${ORIGIN}/ai`)).status).toBe(200);
    // PETTY-416: the shipped program refuses to start without PETTY_API_URL (it used to use http://localhost:3000)
    const dir = mkdtempSync(join(tmpdir(), "petty-mcp-"));
    try {
      writeFileSync(join(dir, "petty-mcp.mjs"), program);
      const env: Record<string, string | undefined> = { ...process.env, PETTY_TOKEN: "petty_pat_test" };
      delete env["PETTY_API_URL"];
      const r = spawnSync(process.execPath, [join(dir, "petty-mcp.mjs")], { encoding: "utf8", input: "", timeout: 20_000, env });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("set PETTY_API_URL");
      expect(r.stdout).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // PETTY-522: release.yml builds the image with the files its pack job signed and published, and run.sh
  // builds it the same way (with one extra file, so a pass shows that the given files filled /downloads).
  // With PETTY_IMAGE=<a release> and PETTY_IT_DOWNLOADS=<that release's files>, this checks a release.
  const given = process.env["PETTY_IT_DOWNLOADS"];
  it.skipIf(!given)("serves the files it was built with at /downloads, byte for byte (PETTY-522)", async () => {
    const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const names = readdirSync(given!).sort();
    for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md", "petty-mcp.mjs", "petty-skill.zip", "petty.mcpb", "petty.mjs"]) expect(names).toContain(f);
    for (const name of names) {
      const r = await fetch(`${ORIGIN}/downloads/${encodeURIComponent(name)}`);
      expect(r.status, name).toBe(200);
      expect(sha256(new Uint8Array(await r.arrayBuffer())), name).toBe(sha256(readFileSync(join(given!, name))));
    }
  });

  it("a file of its own is that file, also once the service worker answers navigations (PETTY-279)", async () => {
    const notices = await fetch(`${ORIGIN}/THIRD_PARTY_NOTICES.md`);
    expect(notices.status).toBe(200);
    const text = await notices.text();
    expect(text).toContain("Third-party notices");
    expect(text).not.toContain("<div id=\"root\"");
    // The shipped worker's rule: a navigation to an address it denies goes to the network; any other gets
    // the app shell. It used to deny only /api and /downloads, so the footer's notices link showed the app.
    const sw = await (await fetch(`${ORIGIN}/sw.js`)).text();
    const list = /denylist:(\[\/.*?\])\}/.exec(sw)?.[1];
    expect(list, "the service worker has a navigation denylist").toBeTruthy();
    const deny = runInNewContext(list!) as RegExp[];
    const shell = (path: string) => !deny.some((r) => r.test(path));
    for (const file of ["/THIRD_PARTY_NOTICES.md", "/robots.txt", "/downloads/petty.mjs", "/api/health"]) expect(shell(file), file).toBe(false);
    for (const route of ["/", "/privacy", "/drawers/0b6f4b4e-8c1e-4f7a-9d0e-2b1a3c4d5e6f", "/device?code=BCDF-GHJK-LMNP-QRST-VWXZ", "/setup", "/unlock"]) expect(shell(route), route).toBe(true);
    // PETTY-404: the sign-in and sign-up pages always come from the server (in clerk mode their policy differs)
    for (const page of ["/login", "/login/factor-one", "/join", "/join/abc_DEF-123", "/join?__clerk_ticket=x"]) expect(shell(page), page).toBe(false);
  });

  it("API answers are never cached, and a malformed id is a 404 (PETTY-193)", async () => {
    const res = await fetch(`${API}/health`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${API}/drawers/not-a-uuid`)).status).toBe(401);
  });
});
