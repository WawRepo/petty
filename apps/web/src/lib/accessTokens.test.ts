import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasskeyVault, createVault, generateUserKeys, randomBytes, sessionKeysFrom, toB64, verifyCustodyProof, verifyDelegation, WrongPassphrase, type UnlockedKeys, type UserKeyPairs } from "@petty/crypto";
import type { Me } from "@petty/protocol";

/**
 * PETTY-452: making a token opens the vault again, inside createAccessToken. The vault here is a real
 * one (Argon2id, AES-256-GCM) and so are the keys; only the server, the session store, the drawers and
 * the passkey prompt are stand-ins. The session is unlocked in every test: that alone must make no token.
 */
const calls: { method: string; path: string; body: unknown }[] = [];
const auth: { current: unknown } = { current: { status: "loading" } };
const prf: { current: Uint8Array | null } = { current: null };

vi.mock("./api.js", () => ({
  ApiError: class ApiError extends Error {},
  api: vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path === "/me/custody-challenge") return { challenge: toB64(randomBytes(32)), expires_at: new Date(Date.now() + 60_000).toISOString() };
    if (method === "POST" && path === "/me/tokens") {
      const b = body as { name: string; role: "read" | "write"; scope: string[] | null; expires_at: string | null; ecdh_pub: string };
      return { id: crypto.randomUUID(), name: b.name, ecdh_pub: b.ecdh_pub, role: b.role, scope: b.scope, created_at: new Date().toISOString(), last_used_at: null, expires_at: b.expires_at };
    }
    return undefined;
  }),
}));
vi.mock("./session.js", () => ({ getAuth: () => auth.current }));
vi.mock("./drawers.js", () => ({ getDrawers: () => ({ drawers: new Map() }), expectedSender: vi.fn(), loadIfIdle: vi.fn() }));
vi.mock("./pins.js", () => ({ trustedTokens: () => [], updateTrustedTokens: vi.fn(async () => undefined) }));
vi.mock("./passkey.js", async (original) => {
  const real = await original<typeof import("./passkey.js")>();
  return {
    ...real,
    evaluatePrf: vi.fn(async () => {
      if (!prf.current) throw new real.PasskeyError("cancelled");
      return { credential_id: "cred-1", prf: prf.current.slice() };
    }),
  };
});

const { createAccessToken } = await import("./accessTokens.js");
const { PasskeyError } = await import("./passkey.js");

const PASSPHRASE = "seven plain words for one test vault";
const USER_ID = "5f0c2a0e-6b1f-4f55-9d0a-1e2d3c4b5a69";
let pairs: UserKeyPairs;
let session: UnlockedKeys;
let me: Me;
const made = () => calls.filter((c) => c.method === "POST" && c.path === "/me/tokens");
const ask = (over: Partial<Parameters<typeof createAccessToken>[0]> = {}) => createAccessToken({ name: "tool", role: "read", scope: null, expiresAt: null, passphrase: null, ...over });

beforeAll(async () => {
  pairs = await generateUserKeys();
  session = await sessionKeysFrom(pairs);
  const passkeyPrf = randomBytes(32);
  me = {
    id: USER_ID,
    keys: { ecdh_pub: session.pub.ecdh, ecdsa_pub: session.pub.ecdsa, sig_key_id: "0123456789abcdef0123456789abcdef", created_at: new Date().toISOString(), retired_at: null },
    pub: session.pub,
    vault: await createVault(PASSPHRASE, pairs),
    passkeys: [{ credential_id: "cred-1", prf_salt: toB64(randomBytes(32)), vault: await createPasskeyVault(passkeyPrf, pairs), label: "laptop" }],
  } as unknown as Me;
  prf.current = passkeyPrf;
}, 60_000);

beforeEach(() => {
  calls.length = 0;
  auth.current = { status: "unlocked", me, keys: session, expiresAt: Date.now() + 3_600_000 };
});

describe("createAccessToken opens the vault again (PETTY-452)", () => {
  it("makes no token for a wrong passphrase, a reading one included", async () => {
    await expect(ask({ role: "read", passphrase: "not the passphrase at all" })).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(ask({ role: "write", passphrase: "not the passphrase at all" })).rejects.toBeInstanceOf(WrongPassphrase);
    expect(calls).toEqual([]);
  }, 60_000);

  it("makes no token when no passphrase is given and the passkey prompt is cancelled", async () => {
    const real = prf.current;
    prf.current = null;
    try {
      await expect(ask({ role: "read" })).rejects.toBeInstanceOf(PasskeyError);
    } finally { prf.current = real; }
    expect(calls).toEqual([]);
  });

  it("makes no token when the passkey opens nothing", async () => {
    const real = prf.current;
    prf.current = randomBytes(32);
    try {
      await expect(ask({ role: "read" })).rejects.toThrow();
    } finally { prf.current = real; }
    expect(calls).toEqual([]);
  });

  it("makes no token when the door opens other keys than this session's", async () => {
    const others = await generateUserKeys();
    auth.current = { status: "unlocked", me: { ...me, vault: await createVault(PASSPHRASE, others) }, keys: session, expiresAt: Date.now() + 3_600_000 };
    await expect(ask({ passphrase: PASSPHRASE })).rejects.toThrow("vault keys differ");
    expect(calls).toEqual([]);
  }, 60_000);

  it("makes a reading token with the right passphrase, and signs the proof with the keys the passphrase opened", async () => {
    const scope = ["0b6f4b4e-8c1e-4f7a-9d0e-2b1a3c4d5e6f"];
    const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const out = await ask({ passphrase: PASSPHRASE, scope, expiresAt });
    expect(out.token).toMatch(/^petty_pat_/);
    expect(made()).toHaveLength(1);
    const body = made()[0]!.body as { scope: string[] | null; expires_at: string | null; role: string; proof: { challenge: string; signature: string }; signing?: unknown };
    expect(body).toMatchObject({ role: "read", scope, expires_at: expiresAt });
    expect(body.signing).toBeUndefined();
    await expect(verifyCustodyProof(session.pub.ecdsa, body.proof.challenge, body.proof.signature)).resolves.toBe(true);
  }, 60_000);

  it("makes a writing token with the passkey, its delegation signed by the keys the passkey opened", async () => {
    const out = await ask({ role: "write" });
    expect(out.row.role).toBe("write");
    const body = made()[0]!.body as { proof: { challenge: string; signature: string }; signing: { ecdsa_pub: string; delegation: Parameters<typeof verifyDelegation>[0] } };
    await expect(verifyCustodyProof(session.pub.ecdsa, body.proof.challenge, body.proof.signature)).resolves.toBe(true);
    const checked = await verifyDelegation(body.signing.delegation, { user_id: USER_ID, sig_key_id: me.keys.sig_key_id, ecdsa_pub: session.pub.ecdsa });
    expect(checked.token_ecdsa_pub).toBe(body.signing.ecdsa_pub);
  });

  it("makes no token while the vault is locked", async () => {
    auth.current = { status: "locked", me };
    await expect(ask({ passphrase: PASSPHRASE })).rejects.toThrow("vault locked");
    expect(calls).toEqual([]);
  });
});
