import { afterEach, describe, expect, it, vi } from "vitest";
import { exportPublicKeys, generateUserKeys, toB64, verifyCustodyProof, type UnlockedKeys, type VaultBlobV1 } from "@petty/crypto";
import type { CustodyProof } from "@petty/protocol";
import { ApiError } from "./api.js";
import { removePasskey, storeRecoveryCode, withCustodyProof } from "./custody.js";

/**
 * PETTY-440, PETTY-441: a key rotation and deleting a line send custody proofs by themselves. The server
 * keeps one challenge per person and a proof works once, so the calls must not overlap.
 */
function server() {
  let current: string | null = null;
  const log: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url !== "/api/me/custody-challenge") throw new Error(`unexpected request: ${url}`);
    current = toB64(crypto.getRandomValues(new Uint8Array(32))); // a new challenge replaces the last one
    log.push("challenge");
    return new Response(JSON.stringify({ challenge: current, expires_at: new Date(Date.now() + 300_000).toISOString() }), { status: 200 });
  });
  /** What the API does with a proof: it must be for the current challenge, and that challenge is spent. */
  const spend = (proof: CustodyProof): boolean => { const ok = proof.challenge === current; current = null; return ok; };
  return { log, spend, steal: () => { current = null; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("withCustodyProof", () => {
  it("runs the calls one after another, each with a fresh proof signed by the account key", async () => {
    const keys = await generateUserKeys();
    const pub = (await exportPublicKeys(keys)).ecdsa;
    const s = server();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const proofs: CustodyProof[] = [];
    const call = (name: string, wait: Promise<void> | null) => async (proof: CustodyProof) => {
      s.log.push(`${name} sent`);
      expect(s.spend(proof)).toBe(true);
      proofs.push(proof);
      if (wait) await wait;
      s.log.push(`${name} done`);
      return name;
    };
    const first = withCustodyProof(keys.ecdsa.privateKey, call("first", held));
    const second = withCustodyProof(keys.ecdsa.privateKey, call("second", null));
    await vi.waitFor(() => expect(s.log).toContain("first sent"));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.log).toEqual(["challenge", "first sent"]); // the second has not asked for its challenge yet
    release();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(s.log).toEqual(["challenge", "first sent", "first done", "challenge", "second sent", "second done"]);
    expect(proofs[0]!.challenge).not.toBe(proofs[1]!.challenge);
    for (const p of proofs) expect(await verifyCustodyProof(pub, p.challenge, p.signature)).toBe(true);
  });

  it("asks again when the challenge was taken in between, three times at most; any other refusal is passed on and the next call still runs", async () => {
    const keys = await generateUserKeys();
    const s = server();
    const refuse = () => { throw new ApiError(403, "CustodyProofRequired"); };
    // another tab asked for a challenge between this one's challenge and its call: the first try is refused
    let tries = 0;
    const once = await withCustodyProof(keys.ecdsa.privateKey, async (proof) => {
      tries++;
      if (tries === 1) s.steal();
      return s.spend(proof) ? "saved" : refuse();
    });
    expect(once).toBe("saved");
    expect(tries).toBe(2);

    tries = 0;
    await expect(withCustodyProof(keys.ecdsa.privateKey, async () => { tries++; return refuse(); })).rejects.toMatchObject({ code: "CustodyProofRequired" });
    expect(tries).toBe(3);

    tries = 0;
    await expect(withCustodyProof(keys.ecdsa.privateKey, async () => { tries++; throw new ApiError(403, "InsufficientRole"); })).rejects.toMatchObject({ code: "InsufficientRole" });
    expect(tries).toBe(1);
    expect(await withCustodyProof(keys.ecdsa.privateKey, async (proof) => s.spend(proof))).toBe(true);
  });
});

/**
 * PETTY-497: the calls the person makes (vault, recovery code, passkeys, tokens, deleting a drawer or the
 * account) go through the same queue. Here the API answers them like the real one: a proof for the current
 * challenge or 403 CustodyProofRequired, before it looks at anything else.
 */
function custodyApi() {
  let current: string | null = null;
  const log: string[] = [];
  const other = { asks: 0 }; // another tab or device asks for a challenge just before the next call arrives
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/me/custody-challenge") {
      current = toB64(crypto.getRandomValues(new Uint8Array(32)));
      log.push("challenge");
      return new Response(JSON.stringify({ challenge: current, expires_at: new Date(Date.now() + 300_000).toISOString() }), { status: 200 });
    }
    if (other.asks > 0) { other.asks--; current = toB64(crypto.getRandomValues(new Uint8Array(32))); }
    const body = JSON.parse(String(init?.body ?? "{}")) as { proof?: CustodyProof; password?: string };
    const ok = body.proof !== undefined && body.proof.challenge === current;
    current = null;
    log.push(`${init?.method} ${url.slice(4)} ${ok ? "saved" : "refused"}${body.password ? ` password=${body.password}` : ""}`);
    return ok ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ code: "CustodyProofRequired" }), { status: 403 });
  });
  return { log, other, take: () => { const p = current; current = null; return p; } };
}

describe("the person's own custody calls (PETTY-497)", () => {
  it("are made again with the same body when another tab took the challenge in between", async () => {
    const keys = await generateUserKeys();
    const unlocked = { ecdsaPrivate: keys.ecdsa.privateKey } as UnlockedKeys;
    const s = custodyApi();
    s.other.asks = 1;
    await storeRecoveryCode(unlocked, { v: 1 } as unknown as VaultBlobV1, "login password");
    s.other.asks = 1;
    await removePasskey("passkey-1", keys.ecdsa.privateKey, "login password");
    expect(s.log).toEqual([
      "challenge", "PUT /me/recovery-vault refused password=login password",
      "challenge", "PUT /me/recovery-vault saved password=login password",
      "challenge", "DELETE /me/passkeys/passkey-1 refused password=login password",
      "challenge", "DELETE /me/passkeys/passkey-1 saved password=login password",
    ]);
  });

  it("wait for a key rotation step in flight instead of taking its challenge", async () => {
    const keys = await generateUserKeys();
    const s = custodyApi();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // a rotation batch: it holds its proof while the request is on the way
    const rotation = withCustodyProof(keys.ecdsa.privateKey, async (proof) => {
      s.log.push("rotation sent");
      await held;
      const ok = proof.challenge === s.take();
      s.log.push(`rotation ${ok ? "saved" : "refused"}`);
      return ok;
    });
    await vi.waitFor(() => expect(s.log).toContain("rotation sent"));
    const person = removePasskey("passkey-2", keys.ecdsa.privateKey);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.log).toEqual(["challenge", "rotation sent"]); // the person's call has not asked for a challenge yet
    release();
    expect(await rotation).toBe(true);
    await person;
    expect(s.log).toEqual(["challenge", "rotation sent", "rotation saved", "challenge", "DELETE /me/passkeys/passkey-2 saved"]);
  });
});
