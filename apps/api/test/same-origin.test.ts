import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * Requests that change something must come from Petty's own pages (PETTY-409). A browser says where a
 * request comes from in Sec-Fetch-Site; the API takes a changing request only when that says
 * "same-origin". A client that sends no such header (the command line, the add-on, curl, an older
 * browser) is not a page of another site, and works as before.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
let U: Client;

beforeAll(async () => {
  await app.ready();
  U = new Client(app, await userMaterial("origin-u", { email: `origin-u-${run}@test.local` }));
  expect((await U.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

/** A request with U's session cookie; `site` is the Sec-Fetch-Site value, null = no such header. */
function send(method: "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, site: string | null, body?: unknown, cookie: string | null = U.cookie) {
  return app.inject({
    method, url, cookies: cookie ? { petty_session: cookie } : {},
    headers: { ...(site === null ? {} : { "sec-fetch-site": site }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
const REFUSED = ["same-site", "cross-site", "none", "", "same-origin, cross-site", "SAME-SITE"];

describe("changing requests must be same-origin (PETTY-409)", () => {
  it("a request with no body passes with Sec-Fetch-Site: same-origin and with no such header", async () => {
    for (const site of ["same-origin", null]) {
      const res = await send("POST", "/me/custody-challenge", site);
      expect(res.statusCode, String(site)).toBe(200);
      expect(res.json().challenge, String(site)).toBeTruthy();
    }
  });

  it("a request with no body is refused for same-site, cross-site, none and any other value", async () => {
    for (const site of REFUSED) {
      const res = await send("POST", "/me/custody-challenge", site);
      expect(res.statusCode, site).toBe(403);
      expect(res.json(), site).toMatchObject({ code: "CrossSiteRequest" });
    }
  });

  it("a refused request changes nothing: the session it tried to end still works", async () => {
    for (const site of ["same-site", "cross-site", "none"]) {
      expect((await send("POST", "/auth/logout", site)).statusCode, site).toBe(403);
      expect((await send("GET", "/me", null)).statusCode, site).toBe(200);
    }
  });

  it("a request with a JSON body follows the same rule, in every changing method", async () => {
    const name = U.user.display_name;
    for (const site of ["same-site", "cross-site", "none"]) {
      expect((await send("PATCH", "/me", site, { display_name: "Changed" })).statusCode, site).toBe(403);
      expect((await send("PUT", "/me/doc", site, {})).statusCode, site).toBe(403);
      expect((await send("DELETE", `/drawers/${crypto.randomUUID()}/transfer`, site)).statusCode, site).toBe(403);
    }
    expect((await send("GET", "/me", null)).json().display_name).toBe(name);
    expect((await send("PATCH", "/me", "same-origin", { display_name: name })).statusCode).toBe(200);
    expect((await send("PATCH", "/me", null, { display_name: name })).statusCode).toBe(200);
  });

  it("reading is not touched: GET and HEAD pass whatever the header says (a link from another site opens the app)", async () => {
    for (const site of ["same-origin", "same-site", "cross-site", "none", null]) {
      expect((await send("GET", "/me", site)).statusCode, String(site)).toBe(200);
      expect((await send("HEAD", "/me", site)).statusCode, String(site)).toBe(200);
      expect((await send("GET", "/config", site, undefined, null)).statusCode, String(site)).toBe(200);
    }
  });

  it("signing in follows the rule too, before anything is looked up", async () => {
    const body = { email: U.user.email, password: U.user.password };
    for (const site of ["same-site", "cross-site", "none"]) {
      const res = await send("POST", "/auth/login", site, body, null);
      expect(res.statusCode, site).toBe(403);
      expect(res.json().code, site).toBe("CrossSiteRequest");
      expect(res.headers["set-cookie"], site).toBeUndefined();
    }
    expect((await send("POST", "/auth/login", "same-origin", body, null)).statusCode).toBe(200);
    expect((await send("POST", "/auth/login", null, body, null)).statusCode).toBe(200);
  });

  it("an access token is used by tools, which send no such header: it works as before", async () => {
    const t = await U.makeAccessToken("read");
    expect(t.res.statusCode).toBe(201);
    const call = (method: "GET" | "DELETE", site: string | null) => app.inject({ method, url: "/me/token", headers: { authorization: `Bearer ${t.bearer}`, ...(site === null ? {} : { "sec-fetch-site": site }) } });
    expect((await call("DELETE", "cross-site")).json().code).toBe("CrossSiteRequest");
    expect((await call("GET", null)).statusCode).toBe(200); // still there
    expect((await call("DELETE", null)).statusCode).toBe(204);
    expect((await call("GET", null)).statusCode).toBe(401);
  });

  it("Node's own fetch, which the command line and the add-on use, sends no Sec-Fetch-Site and is not refused", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // no body, and a JSON body: the two shapes of a tool's changing request
    expect((await fetch(`${base}/auth/logout`, { method: "POST" })).status).toBe(204);
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: U.user.email, password: U.user.password }) });
    expect(login.status).toBe(200);
    // and the rule holds over a real connection as well
    const marked = await fetch(`${base}/auth/logout`, { method: "POST", headers: { "sec-fetch-site": "same-site" } });
    expect(marked.status).toBe(403);
    expect(((await marked.json()) as { code: string }).code).toBe("CrossSiteRequest");
  });
});
