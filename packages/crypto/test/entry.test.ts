import { describe, expect, it } from "vitest";
import { AuthTagMismatch, InvalidPayload, SignatureInvalid, canonicalJson, hashEntry, openEntry, openEntryUnverified, sealEntry, verifyEntry, generateDrawerKey, fromB64, toB64 } from "../src/index.js";
import { author, entryIdentity, makeEntry } from "./helpers.js";

describe("canonicalJson", () => {
  it("sorts keys recursively, drops undefined, rejects NaN", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(InvalidPayload);
  });
});

describe("entry signatures", () => {
  it("signs and verifies under the right author + key id", async () => {
    const a = await author("alice");
    const e = await makeEntry(a);
    await expect(verifyEntry(e, a.author)).resolves.toBeUndefined();
  });

  it("rejects a forged author: signed by someone else's key", async () => {
    const a = await author("alice");
    const m = await author("mallory");
    const e = await makeEntry(a);
    await expect(verifyEntry(e, m.author)).rejects.toBeInstanceOf(SignatureInvalid);
  });

  it("rejects an entry that names alice but carries mallory's key id, even when verified with mallory's key", async () => {
    const a = await author("alice");
    const m = await author("mallory");
    const forged = await makeEntry(m, { author_id: a.id }); // mallory signs "author_id: alice" with her own key
    await expect(verifyEntry(forged, m.author)).rejects.toBeInstanceOf(SignatureInvalid);
    await expect(verifyEntry(forged, { ...m.author, author_id: a.id })).resolves.toBeUndefined(); // only if the caller itself pins mallory's key to alice — the caller's pin table is the boundary
    await expect(verifyEntry(forged, a.author)).rejects.toBeInstanceOf(SignatureInvalid);
  });

  it("rejects a modified payload", async () => {
    const a = await author("alice");
    const e = await makeEntry(a);
    for (const change of [{ amount: 5001 }, { comment: "x" }, { op: "withdraw" as const }, { line_id: "other" }, { logged_at: "2026-01-01T00:00:00.000Z" }]) {
      await expect(verifyEntry({ ...e, ...change }, a.author)).rejects.toBeInstanceOf(SignatureInvalid);
    }
  });

  it("hashEntry is deterministic, independent of signature encoding, and changes with any field", async () => {
    const a = await author("alice");
    const e = await makeEntry(a);
    const h1 = await hashEntry(e);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Same payload, second signature (ECDSA is randomised) → same hash.
    const e2 = await makeEntry(a, { id: e.id });
    expect(e2.sig).not.toBe(e.sig);
    expect(await hashEntry(e2)).toBe(h1);
    // High-s malleated signature still verifies but must not change the hash.
    const sig = fromB64(e.sig);
    const n = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
    let s = 0n; for (const b of sig.subarray(32)) s = (s << 8n) | BigInt(b);
    const s2 = (n - s).toString(16).padStart(64, "0");
    const twin = new Uint8Array(sig); for (let i = 0; i < 32; i++) twin[32 + i] = Number.parseInt(s2.slice(2 * i, 2 * i + 2), 16);
    const malleated = { ...e, sig: toB64(twin) };
    await expect(verifyEntry(malleated, a.author)).resolves.toBeUndefined();
    expect(await hashEntry(malleated)).toBe(h1);
    expect(await hashEntry({ ...e, comment: "." })).not.toBe(h1);
  });

  it("a prev_hash links to the exact prior payload", async () => {
    const a = await author("alice");
    const first = await makeEntry(a, { id: "e1" });
    const second = await makeEntry(a, { id: "e2", prev_hash: await hashEntry(first) });
    expect(second.prev_hash).toBe(await hashEntry(first));
    expect(await hashEntry({ ...first, amount: first.amount + 1 })).not.toBe(second.prev_hash);
  });

  it("shape rules: unknown fields, reverse target, delta_hint, exponent, integer amount, comment bytes", async () => {
    const a = await author("alice");
    await expect(makeEntry(a, { op: "reverse", reverses: null })).rejects.toBeInstanceOf(InvalidPayload);
    await expect(makeEntry(a, { op: "add", reverses: "e0" })).rejects.toBeInstanceOf(InvalidPayload);
    await expect(makeEntry(a, { op: "add", delta_hint: 5 })).rejects.toBeInstanceOf(InvalidPayload);
    await expect(makeEntry(a, { exponent: 9 })).rejects.toBeInstanceOf(InvalidPayload);
    await expect(makeEntry(a, { amount: 1.5 })).rejects.toBeInstanceOf(InvalidPayload);
    await expect(makeEntry(a, { comment: "ż".repeat(1001) })).rejects.toBeInstanceOf(InvalidPayload); // 2002 bytes
    await expect(makeEntry(a, { extra: 1 } as Record<string, unknown>)).rejects.toBeInstanceOf(InvalidPayload);
    await expect(makeEntry(a, { op: "reverse", reverses: "e0", amount: -5000 })).resolves.toBeTruthy();
    await expect(makeEntry(a, { op: "adjust", amount: 100, delta_hint: -4900 })).resolves.toBeTruthy();
  });
});

describe("sealEntry / openEntry", () => {
  it("round-trips through the drawer key and verifies the author", async () => {
    const a = await author("alice");
    const key = await generateDrawerKey();
    const e = await makeEntry(a, { id: "e1", comment: "birthday gift" });
    const id = entryIdentity("e1", { author_id: a.id });
    const sealed = await sealEntry(key, id, e);
    expect(await openEntry(key, id, sealed, a.author)).toEqual(e);
    expect(await openEntryUnverified(key, id, sealed)).toEqual(e);
  });

  it("refuses to seal an entry under an identity that does not match its ids or author", async () => {
    const a = await author("alice");
    const key = await generateDrawerKey();
    const e = await makeEntry(a, { id: "e1" });
    await expect(sealEntry(key, entryIdentity("e2", { author_id: a.id }), e)).rejects.toBeInstanceOf(InvalidPayload);
    await expect(sealEntry(key, entryIdentity("e1", { line_id: "other", author_id: a.id }), e)).rejects.toBeInstanceOf(InvalidPayload);
    await expect(sealEntry(key, entryIdentity("e1", { author_id: "bob" }), e)).rejects.toBeInstanceOf(InvalidPayload);
  });

  it("an entry copied to another line's row or re-attributed to another author fails to open", async () => {
    const a = await author("alice");
    const key = await generateDrawerKey();
    const e = await makeEntry(a, { id: "e1" });
    const sealed = await sealEntry(key, entryIdentity("e1", { author_id: a.id }), e);
    await expect(openEntry(key, entryIdentity("e1", { line_id: "other-line", author_id: a.id }), sealed, a.author)).rejects.toBeInstanceOf(AuthTagMismatch);
    await expect(openEntry(key, entryIdentity("e1", { author_id: "bob" }), sealed, a.author)).rejects.toBeInstanceOf(AuthTagMismatch);
  });

  it("openEntry with the wrong pinned author fails even though the ciphertext opens", async () => {
    const a = await author("alice");
    const b = await author("bob");
    const key = await generateDrawerKey();
    const e = await makeEntry(a, { id: "e1" });
    const id = entryIdentity("e1", { author_id: a.id });
    const sealed = await sealEntry(key, id, e);
    await expect(openEntry(key, id, sealed, b.author)).rejects.toBeInstanceOf(SignatureInvalid);
  });
});
