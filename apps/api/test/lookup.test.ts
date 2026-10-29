import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * The email lookup behind "Invite" (PETTY-408, security review finding #10). The inviter must learn
 * whether an address has an account, so the answer cannot hide it; instead the lookup is limited per
 * user and per client address, and the address travels in a POST body, not in a URL.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
const limits = config as { lookupLimitPerHour: number };
const defaultLimit = limits.lookupLimitPerHour;
let A: Client, B: Client;

beforeAll(async () => {
  await app.ready();
  const mk = async (n: string) => new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }));
  [A, B] = await Promise.all([mk("look-a"), mk("look-b")]);
  for (const c of [A, B]) expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);

afterEach(() => { limits.lookupLimitPerHour = defaultLimit; });
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

// The per-address count lives in the database and outlives this process: a fresh address per test.
const freshAddress = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

function lookup(c: Client | null, email: string, o: { ip: string; get?: boolean }) {
  const cookies = c?.cookie ? { petty_session: c.cookie } : {};
  return o.get
    ? app.inject({ method: "GET", url: `/users/lookup?email=${encodeURIComponent(email)}`, cookies, remoteAddress: o.ip })
    : app.inject({ method: "POST", url: "/users/lookup", cookies, remoteAddress: o.ip, headers: { "content-type": "application/json" }, payload: JSON.stringify({ email }) });
}

describe("email lookup (PETTY-408)", () => {
  it("POST finds an account by its exact address in any case, and answers only id, name and keys", async () => {
    const ip = freshAddress();
    const res = await lookup(A, B.user.email.toUpperCase(), { ip });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["display_name", "id", "keys"]);
    expect(body.id).toBe(B.id);
    expect(body.keys.ecdh_pub).toBe(B.user.pub.ecdh);
    const miss = await lookup(A, `nobody-${run}@test.local`, { ip });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe("UserNotFound");
  });

  it("GET ?email= still answers, for web app tabs opened before the change", async () => {
    const res = await lookup(A, B.user.email, { ip: freshAddress(), get: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(B.id);
  });

  it("needs a signed-in user and a valid address", async () => {
    expect((await lookup(null, B.user.email, { ip: freshAddress() })).statusCode).toBe(401);
    expect((await lookup(A, "not-an-address", { ip: freshAddress() })).statusCode).toBe(400);
  });

  it("each user gets lookupLimitPerHour lookups; then 429, and other users are not affected", async () => {
    limits.lookupLimitPerHour = 2;
    const C = new Client(app, await userMaterial("look-c", { email: `look-c-${run}@test.local` }));
    expect((await C.signup(await makeJoinLink())).statusCode).toBe(201);
    // found and not found count the same: checking a list of addresses is what the limit stops
    expect((await lookup(C, B.user.email, { ip: freshAddress() })).statusCode).toBe(200);
    expect((await lookup(C, `nobody-${run}@test.local`, { ip: freshAddress() })).statusCode).toBe(404);
    const over = await lookup(C, B.user.email, { ip: freshAddress() });
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe("TooManyAttempts");
    expect(over.headers["retry-after"]).toBe("3600");
    // the old GET shares the count
    expect((await lookup(C, B.user.email, { ip: freshAddress(), get: true })).statusCode).toBe(429);
    expect((await lookup(B, A.user.email, { ip: freshAddress() })).statusCode).toBe(200);
  }, 60_000);

  it("one client address gets three times the per-user limit, across accounts", async () => {
    limits.lookupLimitPerHour = 1;
    const ip = freshAddress();
    const users = await Promise.all(["look-d", "look-e", "look-f", "look-g"].map(async (n) => new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }))));
    for (const u of users) expect((await u.signup(await makeJoinLink())).statusCode).toBe(201);
    for (const u of users.slice(0, 3)) expect((await lookup(u, A.user.email, { ip })).statusCode).toBe(200);
    // the fourth account has its own lookup left, but the address has used all three
    expect((await lookup(users[3]!, A.user.email, { ip })).statusCode).toBe(429);
  }, 120_000);

  it("0 turns the limit off", async () => {
    limits.lookupLimitPerHour = 0;
    const ip = freshAddress();
    for (let i = 0; i < 5; i++) expect((await lookup(A, B.user.email, { ip })).statusCode).toBe(200);
  });
});
