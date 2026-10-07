import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceKeyPair, deviceUserCode, openDeviceToken, sealDeviceToken } from "@petty/crypto";
import { buildApp } from "../src/app.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * Device login (PETTY-274): a tool with no session asks, the person allows it on the web app's page,
 * the tool polls. The page seals an ordinary access token to the tool's one-time key; the server
 * relays the sealed blob and never sees the token.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
const ORIGIN = "https://petty.test";
let A: Client;

beforeAll(async () => {
  await app.ready();
  A = new Client(app, await userMaterial("dev-a", { email: `dev-a-${run}@test.local` }));
  expect((await A.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);

afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

// PETTY-334: the per-address limits count in the database and outlive this process: one address per run
const remoteAddress = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

/** What `petty auth login` sends; no cookie, no bearer. */
async function ask(role: "read" | "write" = "write") {
  const tool = await deviceKeyPair();
  const res = await app.inject({
    method: "POST", url: "/device/code", remoteAddress, headers: { "content-type": "application/json" },
    payload: JSON.stringify({ cli_pub: tool.publicB64, client_name: "petty on laptop", role, expires_days: 90 }),
  });
  return { res, tool, body: res.statusCode === 201 ? (res.json() as { request_id: string; device_code: string; user_code: string; expires_in: number; interval: number }) : null };
}
const poll = (deviceCode: string) =>
  app.inject({ method: "POST", url: "/device/token", remoteAddress, headers: { "content-type": "application/json" }, payload: JSON.stringify({ device_code: deviceCode }) });

describe("device login (PETTY-274)", () => {
  it("relays a token sealed to the tool's key: asked, allowed on the page, picked up once", async () => {
    const { res, tool, body } = await ask();
    expect(res.statusCode).toBe(201);
    expect(body!.user_code).toBe(await deviceUserCode(tool.publicB64));
    expect(body!.expires_in).toBe(900);
    expect(body!.interval).toBe(5);

    expect((await poll(body!.device_code)).json().code).toBe("AuthorizationPending");
    expect((await poll(body!.device_code)).json().code).toBe("SlowDown"); // asked again within the interval

    // the page: typed in lower case with spaces, it finds the same request and shows what asks
    const view = await A.call("GET", `/device/${body!.user_code.toLowerCase().replace(/-/g, " ")}`);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ id: body!.request_id, user_code: body!.user_code, cli_pub: tool.publicB64, client_name: "petty on laptop", role: "write", expires_days: 90, ip: remoteAddress });

    // the page makes an ordinary token and seals it to the tool's key
    const made = await A.makeAccessToken("write");
    const ctx = { requestId: body!.request_id, userCode: body!.user_code, origin: ORIGIN };
    const sealed = await sealDeviceToken(tool.publicB64, made.token, ctx);
    expect((await A.call("POST", `/device/${body!.user_code}/approve`, { sealed })).statusCode).toBe(204);
    const stored = await apiPool.query<{ sealed_token: unknown }>("select sealed_token from device_requests where id = $1", [body!.request_id]);
    expect(JSON.stringify(stored.rows[0]!.sealed_token)).not.toContain("petty_pat_");
    expect((await A.call("POST", `/device/${body!.user_code}/approve`, { sealed })).statusCode).toBe(404); // once

    const got = await poll(body!.device_code);
    expect(got.statusCode).toBe(200);
    expect(got.json().request_id).toBe(body!.request_id);
    await expect(openDeviceToken(tool.privateKey, got.json().sealed, ctx)).resolves.toBe(made.token);
    // picked up: the request is gone, and a second poll learns nothing
    expect((await apiPool.query("select 1 from device_requests where id = $1", [body!.request_id])).rowCount).toBe(0);
    expect((await poll(body!.device_code)).json().code).toBe("ExpiredToken");
    // the token is an ordinary one: it works, and Settings lists it
    const me = await app.inject({ method: "GET", url: "/me/token", headers: { authorization: `Bearer ${made.bearer}` } });
    expect(me.statusCode).toBe(200);
    expect((await A.call("GET", "/me/tokens")).json().tokens.map((t: { id: string }) => t.id)).toContain(made.rowId);
  });

  it("tells the tool when the person denies it, and forgets the request", async () => {
    const { body } = await ask("read");
    expect((await A.call("POST", `/device/${body!.user_code}/deny`)).statusCode).toBe(204);
    expect((await poll(body!.device_code)).json().code).toBe("AccessDenied");
    expect((await poll(body!.device_code)).json().code).toBe("ExpiredToken");
    expect((await A.call("GET", `/device/${body!.user_code}`)).statusCode).toBe(404);
  });

  it("ends a request after its 15 minutes, for the page and for the tool", async () => {
    const { body } = await ask();
    await apiPool.query("update device_requests set expires_at = now() - interval '1 second' where id = $1", [body!.request_id]);
    expect((await A.call("GET", `/device/${body!.user_code}`)).json().code).toBe("DeviceCodeUnknown");
    expect((await poll(body!.device_code)).json().code).toBe("ExpiredToken");
    expect((await apiPool.query("select 1 from device_requests where id = $1", [body!.request_id])).rowCount).toBe(0);
  });

  it("shows and allows a request only for a signed-in person, never for a token or nobody", async () => {
    const { body } = await ask();
    const code = body!.user_code;
    expect((await app.inject({ method: "GET", url: `/device/${code}` })).statusCode).toBe(401);
    const { bearer } = await A.makeAccessToken("write");
    const asToken = (method: "GET" | "POST", url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${bearer}`, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload: JSON.stringify(payload) } : {}) });
    expect((await asToken("GET", `/device/${code}`)).json().code).toBe("TokenNotAllowed");
    expect((await asToken("POST", `/device/${code}/deny`)).json().code).toBe("TokenNotAllowed");
    expect((await A.call("GET", "/device/BCDF-GHJK-LMNP")).json().code).toBe("DeviceCodeUnknown");
    expect((await A.call("GET", "/device/not-a-code")).json().code).toBe("DeviceCodeUnknown");
    expect((await poll(body!.device_code)).json().code).toBe("AuthorizationPending"); // still waiting for the person
  });

  it("refuses a key that is not a P-256 public key", async () => {
    const res = await app.inject({
      method: "POST", url: "/device/code", remoteAddress, headers: { "content-type": "application/json" },
      payload: JSON.stringify({ cli_pub: "AAAA", client_name: "x", role: "read", expires_days: null }),
    });
    expect(res.json().code).toBe("DeviceKeyInvalid");
  });

  it("lets a token end itself (petty auth logout), a read-only one too", async () => {
    const { bearer, rowId } = await A.makeAccessToken("read");
    const asToken = (method: "GET" | "DELETE", url: string) => app.inject({ method, url, headers: { authorization: `Bearer ${bearer}` } });
    expect((await asToken("GET", "/me/token")).statusCode).toBe(200);
    expect((await asToken("DELETE", "/me/token")).statusCode).toBe(204);
    expect((await asToken("GET", "/me/token")).statusCode).toBe(401);
    expect((await A.call("GET", "/me/tokens")).json().tokens.map((t: { id: string }) => t.id)).not.toContain(rowId);
  });

  it("limits how often one address may ask", async () => {
    let limited = false;
    for (let i = 0; i < 11 && !limited; i++) limited = (await ask()).res.statusCode === 429;
    expect(limited).toBe(true);
  });
});
