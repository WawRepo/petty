/**
 * Clerk mode (PETTY-88, docs/auth-clerk.md). Tokens are minted here with a test RSA key and
 * verified offline through CLERK_JWT_KEY; the Clerk backend API (profile, deletion, revocation)
 * is mocked — nothing here talks to Clerk.
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

vi.mock("../src/lib/clerk.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/clerk.js")>();
  return {
    ...orig,
    clerkProfile: async (id: string) => ({ email: profileEmail(id), emailVerified: !id.endsWith("UNVERIFIED"), name: `Clerk ${id}` }),
    deleteClerkUser: async () => { deleted.push("x"); },
    revokeClerkSessions: async () => 0,
    clerkUserExists: async (id: string) => !gone.has(id),
  };
});
const deleted: string[] = [];
/** Test hook: Clerk users that no longer exist (PETTY-187). */
const gone = new Set<string>();
/** Test hook: which email Clerk reports for an id (default: derived from the id). */
const emails = new Map<string, string>();
const profileEmail = (id: string) => emails.get(id) ?? `${id.toLowerCase().replace(/unverified$/, "")}@test.local`;

const { buildApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { apiPool, maintPool } = await import("../src/db.js");
const { Client, userMaterial } = await import("../src/devtools/fixtures.js");

const app = buildApp();
const run = Math.random().toString(36).slice(2, 8);
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
const token = (sub: string, over: Record<string, unknown> = {}) =>
  new SignJWT({ sid: `sess_${sub}`, ...over }).setProtectedHeader({ alg: "RS256" }).setSubject(sub).setIssuer("https://clerk.petty.test").setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);

beforeAll(async () => { await app.ready(); }, 60_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

describe("clerk mode", () => {
  it("advertises the mode; local login routes are off; no bearer means 401, a bad token too", async () => {
    expect((await app.inject({ method: "GET", url: "/config" })).json()).toEqual({ auth: "clerk", clerk_publishable_key: "pk_test_offline", contact_email: config.contactEmail || null });
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.c", password: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/join-links/abc" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer not.a.token" } })).statusCode).toBe(401);
    const csp = (await app.inject({ method: "GET", url: "/config" })).headers["content-security-policy"] as string;
    expect(csp).toContain("connect-src 'self' https://clerk.petty.test");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toContain("require-trusted-types-for");
    // PETTY-185 (NR-5): clerk-js is bundled, so Clerk's origin is not a script source
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' https:\/\/challenges\.cloudflare\.com;/);
    expect(/script-src[^;]*clerk\.petty\.test/.test(csp)).toBe(false);
  });

  it("a verified identity with no vault gets NoVault, provisions once, then is a normal user; the custody proof alone gates the vault", async () => {
    const sub = `user_${run}A`;
    const U = new Client(app, await userMaterial("ula"));
    U.bearer = await token(sub);
    const before = await U.call("GET", "/me");
    expect(before.statusCode).toBe(404);
    expect(before.json().code).toBe("NoVault");
    const sb = U.user.signupBody;
    const body = { display_name: sb["display_name"], keys: sb["keys"], vault: sb["vault"], recovery_vault: sb["recovery_vault"] };
    const created = await U.call("POST", "/auth/provision", { ...body, locale: "pl" });
    expect(created.statusCode).toBe(201);
    U.id = created.json().id;
    expect(created.json().email).toBe(`${sub.toLowerCase()}@test.local`);
    expect((await U.call("POST", "/auth/provision", body)).json().code).toBe("AlreadyProvisioned");
    const me = await U.call("GET", "/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().display_name).toBe("Ula");
    // no login password exists: PUT /me/vault takes the custody proof only
    const { createVault, unlockVault } = await import("@petty/crypto");
    const rv = await U.call("GET", "/me/recovery-vault");
    const keys = await unlockVault(rv.json().recovery_vault, U.user.recovery_code, { extractable: true });
    const pairs = { ecdh: { privateKey: keys.ecdhPrivate, publicKey: U.user.keys.ecdh.publicKey }, ecdsa: { privateKey: keys.ecdsaPrivate, publicKey: U.user.keys.ecdsa.publicKey } };
    const newVault = await createVault("another passphrase 2026 x", pairs);
    expect((await U.call("PUT", "/me/vault", { vault: newVault })).statusCode).toBe(400); // no proof
    expect((await U.call("PUT", "/me/vault", { proof: await U.proof(), vault: newVault })).statusCode).toBe(204);
    // a drawer works as in local mode
    const d = await U.createDrawer("Tin");
    expect(d.res.statusCode).toBe(201);
    // blocked: the token still verifies, the user is refused
    await owner.query("update users set blocked_at = now() where id = $1", [U.id]);
    expect((await U.call("GET", "/me")).statusCode).toBe(404); // identity known, user row not usable -> no vault from this token's view
    await owner.query("update users set blocked_at = null where id = $1", [U.id]);
    expect((await U.call("GET", "/me")).statusCode).toBe(200);
    // deletion: custody proof only, and the Clerk user goes with it
    expect((await U.call("POST", "/me/delete", { proof: await U.proof(), decisions: [] })).statusCode).toBe(204);
    expect(deleted.length).toBe(1);
    expect((await U.call("GET", "/me")).statusCode).toBe(404);
  }, 60_000);

  it("PETTY-104: a new Clerk identity with the same VERIFIED email relinks the existing account (vault kept); an unverified email does not", async () => {
    const first = `user_${run}R1`;
    const U = new Client(app, await userMaterial("rita"));
    U.bearer = await token(first);
    const sb = U.user.signupBody;
    const created = await U.call("POST", "/auth/provision", { display_name: sb["display_name"], keys: sb["keys"], vault: sb["vault"], recovery_vault: sb["recovery_vault"] });
    expect(created.statusCode).toBe(201);
    const email = created.json().email as string;
    // The Clerk account is replaced (say, a GitHub sign-up for the same address): new sub, same verified email.
    const second = `user_${run}R2`;
    emails.set(second, email.toUpperCase()); // case must not matter
    U.bearer = await token(second);
    // PETTY-187 (NR-7): while the first Clerk user still exists, the row is not taken over
    expect((await U.call("GET", "/me")).json().code).toBe("NoVault");
    expect((await apiPool.query("select clerk_user_id from users where id = $1", [created.json().id])).rows[0].clerk_user_id).toBe(first);
    gone.add(first);
    const me = await U.call("GET", "/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(created.json().id);
    expect(me.json().vault.kind).toBe("passphrase");
    expect((await apiPool.query("select clerk_user_id from users where id = $1", [created.json().id])).rows[0].clerk_user_id).toBe(second);
    // Provisioning again is refused: the account exists.
    expect((await U.call("POST", "/auth/provision", { keys: sb["keys"], vault: sb["vault"], recovery_vault: sb["recovery_vault"] })).json().code).toBe("AlreadyProvisioned");
    // A third identity whose email Clerk has NOT verified gets nothing.
    const third = `user_${run}R3UNVERIFIED`;
    emails.set(third, email);
    U.bearer = await token(third);
    expect((await U.call("GET", "/me")).json().code).toBe("NoVault");
    expect((await apiPool.query("select clerk_user_id from users where id = $1", [created.json().id])).rows[0].clerk_user_id).toBe(second);
  });

  it("an expired token is refused", async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setSubject("user_old").setIssuer("https://clerk.petty.test").setIssuedAt(Math.floor(Date.now() / 1000) - 600).setExpirationTime(Math.floor(Date.now() / 1000) - 300).sign(pair.privateKey);
    expect((await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(401);
  });
});
