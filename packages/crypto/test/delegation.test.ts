import { describe, expect, it } from "vitest";
import { SignatureInvalid } from "../src/errors.js";
import { toB64 } from "../src/encoding.js";
import { delegationCovers, signDelegation, verifyDelegation } from "../src/delegation.js";
import { signCustodyChallenge, verifyCustodyProof } from "../src/custody.js";
import { signEntry, verifyEntry } from "../src/entry.js";
import { exportPublicKeys, importEcdsaPublic, signingKeyId } from "../src/keys.js";
import { author, makeEntry } from "./helpers.js";

/** PETTY-184 (review NR-4): a writing token signs with its own key, vouched for by the account key. */
async function tokenKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return { pair, pub, id: await signingKeyId(pub) };
}

describe("signing delegation (PETTY-184)", () => {
  it("the account key vouches for a token key; entries signed by the token key verify under it", async () => {
    const a = await author();
    const t = await tokenKey();
    const d = await signDelegation(a.keys.ecdsa.privateKey, { user_id: a.id, account_sig_key_id: a.sigKeyId, token_ecdsa_pub: t.pub, created_at: "2026-09-19T00:00:00.000Z", expires_at: null });
    expect(d.token_sig_key_id).toBe(t.id);
    const ok = await verifyDelegation(JSON.parse(JSON.stringify(d)), { user_id: a.id, sig_key_id: a.sigKeyId, ecdsa_pub: (await exportPublicKeys(a.keys)).ecdsa });
    const e = await makeEntry(a, {});
    const payload: Record<string, unknown> = { ...e, sig_key_id: t.id };
    delete payload["sig"];
    const signed = await signEntry(payload as unknown as Parameters<typeof signEntry>[0], t.pair.privateKey);
    await expect(verifyEntry(signed, { author_id: a.id, sig_key_id: ok.token_sig_key_id, ecdsaPublic: await importEcdsaPublic(ok.token_ecdsa_pub) })).resolves.toBeUndefined();
  });

  it("refuses a delegation signed by another key, for another user, or with a swapped token key", async () => {
    const a = await author();
    const mallory = await author();
    const t = await tokenKey();
    const other = await tokenKey();
    const base = { user_id: a.id, account_sig_key_id: a.sigKeyId, token_ecdsa_pub: t.pub, created_at: "2026-09-19T00:00:00.000Z", expires_at: null };
    const acct = { user_id: a.id, sig_key_id: a.sigKeyId, ecdsa_pub: (await exportPublicKeys(a.keys)).ecdsa };
    const forged = await signDelegation(mallory.keys.ecdsa.privateKey, base);
    await expect(verifyDelegation(forged, acct)).rejects.toBeInstanceOf(SignatureInvalid);
    const real = await signDelegation(a.keys.ecdsa.privateKey, base);
    await expect(verifyDelegation({ ...real, token_ecdsa_pub: other.pub, token_sig_key_id: other.id }, acct)).rejects.toBeInstanceOf(SignatureInvalid);
    await expect(verifyDelegation({ ...real, token_ecdsa_pub: other.pub }, acct)).rejects.toBeInstanceOf(SignatureInvalid);
    await expect(verifyDelegation(real, { ...acct, user_id: mallory.id })).rejects.toBeInstanceOf(SignatureInvalid);
    await expect(verifyDelegation({ ...real, expires_at: "2030-01-01T00:00:00.000Z" }, acct)).rejects.toBeInstanceOf(SignatureInvalid);
  });

  it("covers only entries received before expiry and before revocation", async () => {
    const d = { v: 1 as const, user_id: "u", account_sig_key_id: "k", token_ecdsa_pub: "p", token_sig_key_id: "t", created_at: "2026-09-01T00:00:00.000Z", expires_at: "2026-10-01T00:00:00.000Z" };
    expect(delegationCovers(d, "2026-09-15T00:00:00.000Z", null)).toBe(true);
    expect(delegationCovers(d, "2026-10-02T00:00:00.000Z", null)).toBe(false);
    expect(delegationCovers(d, "2026-09-15T00:00:00.000Z", "2026-09-10T00:00:00.000Z")).toBe(false);
    expect(delegationCovers({ ...d, expires_at: null }, "2030-01-01T00:00:00.000Z", null)).toBe(true);
  });

  it("a custody proof signed with a token key does not pass as the account's", async () => {
    const a = await author();
    const t = await tokenKey();
    const challenge = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const byToken = await signCustodyChallenge(t.pair.privateKey, challenge);
    expect(await verifyCustodyProof((await exportPublicKeys(a.keys)).ecdsa, challenge, byToken)).toBe(false);
  });
});
