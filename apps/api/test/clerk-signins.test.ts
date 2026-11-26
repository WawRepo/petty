/**
 * PETTY-285: under Clerk, the API counts a sign-in the first time a request carries a Clerk session, and the
 * session tokens it refuses, by reason. Tokens are minted here with a test RSA key and verified offline
 * through CLERK_JWT_KEY, as in clerk.test.ts; the Clerk backend API is mocked: nothing here talks to Clerk.
 * A file of its own, so its metrics registry counts only what these tests do.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";

const pair = await generateKeyPair("RS256");
const stranger = await generateKeyPair("RS256");
process.env["AUTH_PROVIDER"] = "clerk";
process.env["CLERK_JWT_KEY"] = await exportSPKI(pair.publicKey);
process.env["CLERK_SECRET_KEY"] = "sk_test_offline";
process.env["CLERK_PUBLISHABLE_KEY"] = "pk_test_offline";
process.env["CLERK_FRONTEND_API"] = "https://clerk.petty.test";

vi.mock("../src/lib/clerk.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/clerk.js")>();
  return {
    ...orig,
    clerkProfile: async () => { throw new Error("offline"); }, // no vault for these people: the relink finds nothing
    deleteClerkUser: async () => undefined,
    revokeClerkSessions: async () => 0,
    clerkUserExists: async () => true,
  };
});

const { buildApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { apiPool, maintPool } = await import("../src/db.js");
const { registry } = await import("../src/lib/metrics.js");
const { forgetClerkSessions } = await import("../src/lib/clerk-sessions.js");
const { refusalOf } = await import("../src/lib/clerk.js");

const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
const now = () => Math.floor(Date.now() / 1000);
// @clerk/backend 3.28+ accepts a session token only with Clerk's `cat` header (PETTY-540).
const token = (sub: string, sid: string, over: { key?: CryptoKey; claims?: Record<string, unknown>; iat?: number; exp?: number } = {}) =>
  new SignJWT({ sid, azp: new URL(config.appUrl).origin, ...over.claims }).setProtectedHeader({ alg: "RS256", cat: "cl_B7d4PD111AAA" }).setSubject(sub)
    .setIssuer("https://clerk.petty.test").setIssuedAt(over.iat ?? now()).setExpirationTime(over.exp ?? now() + 300).sign(over.key ?? pair.privateKey);
const me = (bearer: string) => app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${bearer}` } });
const count = async (event: string) => Number(new RegExp(`^petty_auth_events_total\\{event="${event}"\\} (\\d+)$`, "m").exec(await registry.metrics())?.[1] ?? NaN);
const rows = async (sid: string) =>
  Number((await owner.query<{ n: string }>("select count(*) as n from clerk_sessions_seen where sid_hash = $1", [createHash("sha256").update(sid).digest()])).rows[0]!.n);

beforeAll(async () => { await app.ready(); }, 60_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

describe("Clerk sign-ins and refused session tokens (PETTY-285)", () => {
  it("starts the Clerk events at 0, and lists no event that only local sign-in has", async () => {
    const text = await registry.metrics();
    for (const event of ["signup", "clerk_signin", "clerk_token_expired", "clerk_token_invalid", "device_code", "device_approved", "device_denied"]) {
      expect(text, event).toMatch(new RegExp(`^petty_auth_events_total\\{event="${event}"\\} 0$`, "m"));
    }
    for (const event of ["login_ok", "login_fail", "rate_limited", "forgot", "reset", "logout"]) expect(text, event).not.toContain(`event="${event}"`);
  });

  it("counts a session once: the first request with it, not the next ones, not after a restart", async () => {
    const sid = `sess_${run}one`;
    const t = await token(`user_${run}one`, sid);
    expect((await me(t)).statusCode).toBe(404); // signed in to Clerk, no vault yet: the count does not need one
    await expect.poll(() => count("clerk_signin")).toBe(1);
    expect(await rows(sid)).toBe(1);
    await me(t);
    await me(await token(`user_${run}one`, sid)); // a fresh token of the same session
    forgetClerkSessions(); // a restart: the process forgets, the table remembers
    await me(t);
    await expect.poll(() => rows(sid)).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await count("clerk_signin")).toBe(1);
    // another session of the same person is another sign-in
    await me(await token(`user_${run}one`, `sess_${run}two`));
    await expect.poll(() => count("clerk_signin")).toBe(2);
    // the table holds a hash of the id, never the id
    expect((await owner.query("select 1 from clerk_sessions_seen where sid_hash = convert_to($1, 'UTF8')", [sid])).rowCount).toBe(0);
  });

  it("counts a refused token as expired or invalid, and counts no sign-in for it", async () => {
    const before = { expired: await count("clerk_token_expired"), invalid: await count("clerk_token_invalid"), signin: await count("clerk_signin") };
    const sub = `user_${run}bad`;
    expect((await me(await token(sub, `sess_${run}old`, { iat: now() - 900, exp: now() - 600 }))).statusCode).toBe(401);
    expect((await me(await token(sub, `sess_${run}soon`, { iat: now() + 600, exp: now() + 900 }))).statusCode).toBe(401);
    expect(await count("clerk_token_expired")).toBe(before.expired + 2);
    expect((await me(await token(sub, `sess_${run}forged`, { key: stranger.privateKey }))).statusCode).toBe(401);
    expect((await me(await token(sub, `sess_${run}azp`, { claims: { azp: "https://evil.test" } }))).statusCode).toBe(401);
    expect((await me("not.a.token")).statusCode).toBe(401);
    expect(await count("clerk_token_invalid")).toBe(before.invalid + 3);
    // no bearer at all is not a refused token, and an access token is not a Clerk token
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await me("petty_pat_nope")).statusCode).toBe(401);
    expect(await count("clerk_token_invalid")).toBe(before.invalid + 3);
    expect(await count("clerk_signin")).toBe(before.signin);
    for (const sid of ["old", "soon", "forged", "azp"]) expect(await rows(`sess_${run}${sid}`)).toBe(0);
  });

  it("reads Clerk's reasons: a time-window problem is expired, anything else invalid", () => {
    for (const reason of ["token-expired", "token-not-active-yet", "token-iat-in-the-future"]) expect(refusalOf({ reason })).toBe("expired");
    for (const reason of ["token-invalid-signature", "token-invalid-authorized-parties", "jwk-kid-mismatch", "jwk-remote-failed-to-load", "token-invalid"]) expect(refusalOf({ reason })).toBe("invalid");
    expect(refusalOf(new Error("x"))).toBe("invalid");
    expect(refusalOf(undefined)).toBe("invalid");
  });
});
