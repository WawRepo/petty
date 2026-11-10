/**
 * What Clerk mode refuses (docs/auth-clerk.md). As in clerk.test.ts, tokens are minted here with a test
 * RSA key and verified offline through CLERK_JWT_KEY, and the Clerk backend API is mocked: nothing here
 * talks to Clerk.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";

const pair = await generateKeyPair("RS256");
process.env["AUTH_PROVIDER"] = "clerk";
process.env["CLERK_JWT_KEY"] = await exportSPKI(pair.publicKey);
process.env["CLERK_SECRET_KEY"] = "sk_test_offline";
process.env["CLERK_PUBLISHABLE_KEY"] = "pk_test_offline";
process.env["CLERK_FRONTEND_API"] = "https://clerk.petty.test";

/** Test hook: the Clerk users whose primary email Clerk has verified. */
const verified = new Set<string>();
vi.mock("../src/lib/clerk.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/clerk.js")>();
  return {
    ...orig,
    clerkProfile: async (id: string) => ({ email: `${id.toLowerCase()}@test.local`, emailVerified: verified.has(id), name: `Clerk ${id}` }),
    deleteClerkUser: async () => undefined,
    revokeClerkSessions: async () => 0,
    clerkUserExists: async () => true,
  };
});

const { buildApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { apiPool, maintPool } = await import("../src/db.js");
const { Client, userMaterial } = await import("../src/devtools/fixtures.js");

const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
const token = (sub: string) =>
  new SignJWT({ sid: `sess_${sub}`, azp: new URL(config.appUrl).origin }).setProtectedHeader({ alg: "RS256" }).setSubject(sub).setIssuer("https://clerk.petty.test").setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);

beforeAll(async () => { await app.ready(); }, 60_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

/** A person signed in with Clerk whose vault exists. */
async function provisioned(name: string) {
  const sub = `user_${run}${name}`;
  verified.add(sub);
  const c = new Client(app, await userMaterial(name));
  c.bearer = await token(sub);
  const sb = c.user.signupBody;
  const made = await c.call("POST", "/auth/provision", { display_name: sb["display_name"], keys: sb["keys"], vault: sb["vault"], recovery_vault: sb["recovery_vault"] });
  expect(made.statusCode).toBe(201);
  c.id = made.json().id;
  return c;
}

describe("clerk mode: changing requests must be same-origin (PETTY-409)", () => {
  it("a session token does not lift the rule; no Sec-Fetch-Site header and same-origin pass", async () => {
    const c = await provisioned("so");
    const send = (site: string | null) => app.inject({ method: "POST", url: "/me/custody-challenge", headers: { authorization: `Bearer ${c.bearer}`, ...(site === null ? {} : { "sec-fetch-site": site }) } });
    for (const site of ["same-site", "cross-site", "none"]) {
      const res = await send(site);
      expect(res.statusCode, site).toBe(403);
      expect(res.json().code, site).toBe("CrossSiteRequest");
    }
    expect((await send("same-origin")).statusCode).toBe(200);
    expect((await send(null)).statusCode).toBe(200);
    // reading is not touched
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${c.bearer}`, "sec-fetch-site": "cross-site" } })).statusCode).toBe(200);
  }, 60_000);
});
