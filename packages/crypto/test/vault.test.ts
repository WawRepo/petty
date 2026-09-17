import { describe, expect, it } from "vitest";
import { InvalidPayload, WrongPassphrase, createPasskeyVault, createRecoveryVault, createVault, exportPublicKeys, generateRecoveryCode, generateUserKeys, normalizeRecoveryCode, randomBytes, safetyNumber, unlockPasskeyVault, unlockVault, utf8, type VaultBlobV1 } from "../src/index.js";

const PASS = "correct horse battery staple";

describe("vault", () => {
  it("wraps both private keys; unlock yields non-extractable keys that work", async () => {
    const keys = await generateUserKeys();
    const blob = await createVault(PASS, keys);
    expect(blob.kdf.name).toBe("argon2id");
    const u = await unlockVault(blob, PASS);
    expect(u.ecdhPrivate.extractable).toBe(false);
    expect(u.ecdsaPrivate.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", u.ecdsaPrivate)).rejects.toThrow();
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, u.ecdsaPrivate, utf8("m"));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.ecdsa.publicKey, sig, utf8("m"))).toBe(true);
    expect(u.pub).toEqual(await exportPublicKeys(keys));
  }, 30_000);

  it("wrong passphrase → WrongPassphrase; the error carries no passphrase", async () => {
    const keys = await generateUserKeys();
    const blob = await createVault(PASS, keys);
    try {
      await unlockVault(blob, PASS + "x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WrongPassphrase);
      const err = e as WrongPassphrase;
      expect(JSON.stringify(err) + err.message + String(err.stack)).not.toContain(PASS);
    }
  }, 30_000);

  it("a substituted public key in the blob fails to open (pub is authenticated by the wraps' AAD)", async () => {
    const keys = await generateUserKeys();
    const attacker = await exportPublicKeys(await generateUserKeys());
    const blob = await createVault(PASS, keys);
    const tampered: VaultBlobV1 = { ...blob, pub: attacker };
    await expect(unlockVault(tampered, PASS)).rejects.toBeInstanceOf(WrongPassphrase);
    const halfTampered: VaultBlobV1 = { ...blob, pub: { ecdh: attacker.ecdh, ecdsa: blob.pub.ecdsa } };
    await expect(unlockVault(halfTampered, PASS)).rejects.toBeInstanceOf(WrongPassphrase);
    const kindSwapped: VaultBlobV1 = { ...blob, kind: "recovery" };
    await expect(unlockVault(kindSwapped, PASS)).rejects.toBeInstanceOf(InvalidPayload); // kdf name/kind disagree → rejected before KDF
  }, 60_000);

  it("rejects out-of-range KDF parameters in a stored blob instead of running them", async () => {
    const keys = await generateUserKeys();
    const blob = await createVault(PASS, keys);
    const weak: VaultBlobV1 = { ...blob, kdf: { ...(blob.kdf as Extract<VaultBlobV1["kdf"], { name: "argon2id" }>), m: 8, t: 1 } };
    await expect(unlockVault(weak, PASS)).rejects.toBeInstanceOf(InvalidPayload);
    const huge: VaultBlobV1 = { ...blob, kdf: { ...(blob.kdf as Extract<VaultBlobV1["kdf"], { name: "argon2id" }>), m: 8 * 1024 * 1024 } };
    await expect(unlockVault(huge, PASS)).rejects.toBeInstanceOf(InvalidPayload);
    const unknownKdf = { ...blob, kdf: { name: "pbkdf2", salt: "AAAA" } } as unknown as VaultBlobV1;
    await expect(unlockVault(unknownKdf, PASS)).rejects.toBeInstanceOf(InvalidPayload);
  }, 30_000);

  it("NFKC-normalises the passphrase", async () => {
    const keys = await generateUserKeys();
    const blob = await createVault("ﬁne passphrase 12345", keys); // U+FB01 ligature
    await expect(unlockVault(blob, "fine passphrase 12345")).resolves.toBeTruthy();
  }, 30_000);

  it("enforces the passphrase length floor", async () => {
    const keys = await generateUserKeys();
    await expect(createVault("short", keys)).rejects.toBeInstanceOf(InvalidPayload);
  });

  it("the blob holds no private key material in the clear", async () => {
    const keys = await generateUserKeys();
    const blob = await createVault(PASS, keys);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.ecdsa.privateKey)).toString("base64");
    expect(JSON.stringify(blob)).not.toContain(pkcs8.slice(40, 80));
  }, 30_000);

  it("extractable unlock is opt-in", async () => {
    const keys = await generateUserKeys();
    const blob = await createVault(PASS, keys);
    const u = await unlockVault(blob, PASS, { extractable: true });
    expect(u.ecdhPrivate.extractable).toBe(true);
  }, 30_000);
});

describe("recovery code", () => {
  it("is 30 Crockford characters and normalises forgivingly", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(code.replace(/-/g, ""));
    expect(normalizeRecoveryCode("oil")).toBe("011");
  });

  it("opens the recovery vault; a wrong code does not; the recovery blob cannot be opened as a passphrase blob", async () => {
    const keys = await generateUserKeys();
    const code = generateRecoveryCode();
    const blob = await createRecoveryVault(code, keys);
    expect(blob.kind).toBe("recovery");
    const u = await unlockVault(blob, code.toLowerCase());
    expect(u.pub).toEqual(await exportPublicKeys(keys));
    const wrong = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
    await expect(unlockVault(blob, wrong)).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(unlockVault({ ...blob, kind: "passphrase" }, code)).rejects.toBeInstanceOf(InvalidPayload);
  });
});

describe("passkey vault (Phase 14)", () => {
  it("opens with the same 32-byte PRF output only; keys come back non-extractable", async () => {
    const keys = await generateUserKeys();
    const prf = randomBytes(32);
    const blob = await createPasskeyVault(prf, keys);
    expect(blob.kind).toBe("passkey");
    expect(blob.kdf.name).toBe("prf-hkdf-sha256");
    const u = await unlockPasskeyVault(blob, prf);
    expect(u.pub).toEqual(await exportPublicKeys(keys));
    expect(u.ecdhPrivate.extractable).toBe(false);
    const other = randomBytes(32);
    await expect(unlockPasskeyVault(blob, other)).rejects.toBeInstanceOf(WrongPassphrase);
    const flipped = new Uint8Array(prf); flipped[0] = (flipped[0]! ^ 1);
    await expect(unlockPasskeyVault(blob, flipped)).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it("rejects wrong PRF lengths, passphrase-style opening, and a swapped kind", async () => {
    const keys = await generateUserKeys();
    const prf = randomBytes(32);
    const blob = await createPasskeyVault(prf, keys);
    await expect(createPasskeyVault(randomBytes(16), keys)).rejects.toBeInstanceOf(InvalidPayload);
    await expect(unlockPasskeyVault(blob, randomBytes(31))).rejects.toBeInstanceOf(InvalidPayload);
    await expect(unlockVault(blob, "any string")).rejects.toBeInstanceOf(InvalidPayload);
    await expect(unlockPasskeyVault({ ...blob, kind: "recovery" }, prf)).rejects.toBeInstanceOf(InvalidPayload);
    const passBlob = await createVault("correct horse battery staple", keys);
    await expect(unlockPasskeyVault(passBlob, prf)).rejects.toBeInstanceOf(InvalidPayload);
    await expect(unlockVault({ ...passBlob, kind: "passkey" }, "correct horse battery staple")).rejects.toBeInstanceOf(InvalidPayload);
  }, 30_000);

  it("does not zero the caller's PRF buffer implicitly, but the blob never contains it", async () => {
    const keys = await generateUserKeys();
    const prf = randomBytes(32);
    const blob = await createPasskeyVault(prf, keys);
    expect(JSON.stringify(blob)).not.toContain(Buffer.from(prf).toString("base64").slice(0, 20));
  });
});

describe("safety number", () => {
  it("is 30 digits in six groups, stable, and differs per key", async () => {
    const a = await exportPublicKeys(await generateUserKeys());
    const b = await exportPublicKeys(await generateUserKeys());
    const sa = await safetyNumber(a);
    expect(sa).toMatch(/^(\d{5} ){5}\d{5}$/);
    expect(await safetyNumber(a)).toBe(sa);
    expect(await safetyNumber(b)).not.toBe(sa);
    expect(await safetyNumber({ ecdh: a.ecdh, ecdsa: b.ecdsa })).not.toBe(sa);
  });
});
