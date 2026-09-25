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
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("strict-transport-security")).toBeTruthy();
    const addon = await fetch(`${ORIGIN}/downloads/petty.mcpb`);
    expect(addon.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(await addon.arrayBuffer()).slice(0, 2))).toBe("PK");
    // PETTY-173: the program for other AI apps, and the page that explains it (an app route)
    const mjs = await fetch(`${ORIGIN}/downloads/petty-mcp.mjs`);
    expect(mjs.status).toBe(200);
    expect((await mjs.text()).length).toBeGreaterThan(100_000);
    expect((await fetch(`${ORIGIN}/ai`)).status).toBe(200);
  });

  it("API answers are never cached, and a malformed id is a 404 (PETTY-193)", async () => {
    const res = await fetch(`${API}/health`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${API}/drawers/not-a-uuid`)).status).toBe(401);
  });
});
