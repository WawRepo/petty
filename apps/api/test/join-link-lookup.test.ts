import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";
import { safeUrl } from "../src/lib/tracing.js";

/**
 * What a join link is for, before the sign-up form shows (PETTY-457). The token is a secret and travels in
 * the body of POST /join-links/lookup: an address ends up in the logs of every proxy on the way, a body
 * does not. No route takes the token, or an email address, from an address any more.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
let A: Client;

beforeAll(async () => {
  await app.ready();
  A = new Client(app, await userMaterial("jl-a", { email: `jl-a-${run}@test.local` }));
  expect((await A.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

const lookup = (body: unknown) => app.inject({ method: "POST", url: "/join-links/lookup", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });

describe("join link lookup (PETTY-457)", () => {
  it("says who invited and for which address, to anyone who holds the token", async () => {
    const email = `friend-${run}@test.local`;
    const made = await A.call("POST", "/join-links", { email });
    expect(made.statusCode).toBe(201);
    const res = await lookup({ token: made.json().token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, inviter_name: A.user.display_name, email });
    expect(res.headers["cache-control"]).toBe("no-store");
    // a link from the operator's script names nobody and no address
    expect((await lookup({ token: await makeJoinLink() })).json()).toEqual({ valid: true, inviter_name: null, email: null });
  });

  it("a token that is unknown or used is not valid, and says nothing else", async () => {
    expect((await lookup({ token: "not-a-real-token" })).json()).toEqual({ valid: false, inviter_name: null, email: null });
    const token = await makeJoinLink();
    const B = new Client(app, await userMaterial("jl-b", { email: `jl-b-${run}@test.local` }));
    expect((await B.signup(token)).statusCode).toBe(201);
    expect((await lookup({ token })).json()).toEqual({ valid: false, inviter_name: null, email: null });
  }, 60_000);

  it("needs a token in a JSON body", async () => {
    for (const body of [{}, { token: "" }, { token: 7 }, { token: "x".repeat(129) }]) {
      const res = await lookup(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code).toBe("ValidationError");
    }
    expect((await app.inject({ method: "POST", url: "/join-links/lookup" })).statusCode).toBe(400);
  });

  it("no route takes the token from the address", async () => {
    const token = await makeJoinLink();
    for (const url of [`/join-links/${token}`, `/join-links/lookup?token=${token}`, `/join-links/lookup/${token}`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('"valid"');
    }
    // the link is untouched by those requests
    expect((await lookup({ token })).json().valid).toBe(true);
  });

  it("a program that still asks the old way leaves no token in a log line or a trace", () => {
    const asked = (url: string, tpl?: string) => safeUrl({ url, routeOptions: { url: tpl } } as unknown as FastifyRequest);
    expect(asked("/join-links/SECRET-JOIN-TOKEN")).toBe("/join-links/…");
    expect(asked("/api/join-links/SECRET-JOIN-TOKEN")).toBe("/api/…");
    expect(asked("/api/join-links/lookup", "/api/join-links/lookup")).toBe("/api/join-links/lookup");
  });
});
