import { describe, expect, it } from "vitest";
import { AuthTagMismatch, InvalidPayload, UnknownSchemaVersion, BUCKET_BYTES, generateDrawerKey, open, reseal, seal, utf8, fromUtf8, toHex, pad, unpad, canonicalJson, type RecordIdentity } from "../src/index.js";
import { sealWithNonce } from "../src/testing.js";
import { AUTHOR, DRAWER, LINE, entryIdentity } from "./helpers.js";

const NONCE = new Uint8Array(12).fill(7);

describe("padding", () => {
  it("rounds up to whole buckets and round-trips", () => {
    for (const n of [0, 1, 251, 252, 253, 1000]) {
      const pt = new Uint8Array(n).fill(9);
      const p = pad(pt, 256);
      expect(p.length % 256).toBe(0);
      expect(p.length).toBeGreaterThanOrEqual(n + 4);
      expect(unpad(p)).toEqual(pt);
    }
  });
  it("rejects a length prefix that overruns and non-zero padding", () => {
    const p = pad(new Uint8Array(3), 256);
    p[3] = 255;
    expect(() => unpad(p)).toThrow(InvalidPayload);
    const q = pad(new Uint8Array(3), 256);
    q[200] = 1;
    expect(() => unpad(q)).toThrow(InvalidPayload);
  });
});

describe("canonicalJson", () => {
  it("rejects __proto__ keys from parsed JSON instead of polluting", () => {
    expect(() => canonicalJson(JSON.parse('{"a":1,"__proto__":{"x":1}}'))).toThrow(InvalidPayload);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});

describe("seal / open", () => {
  it("round-trips and binds identity", async () => {
    const key = await generateDrawerKey();
    const id = entryIdentity("e1");
    const sealed = await seal(key, id, utf8("hello"));
    expect(fromUtf8(await open(key, id, sealed))).toBe("hello");
  });

  it("is deterministic under an injected nonce (test hook only) and random otherwise", async () => {
    const key = await generateDrawerKey();
    const id = entryIdentity("e1");
    const a = await sealWithNonce(key, id, utf8("x"), NONCE);
    const b = await sealWithNonce(key, id, utf8("x"), NONCE);
    expect(toHex(a.ciphertext)).toBe(toHex(b.ciphertext));
    const c = await seal(key, id, utf8("x"));
    const d = await seal(key, id, utf8("x"));
    expect(toHex(c.nonce)).not.toBe(toHex(d.nonce));
    expect(toHex(c.ciphertext)).not.toBe(toHex(a.ciphertext));
  });

  it("hides the amount within one bucket; documents the 256 B step leak above it", async () => {
    const key = await generateDrawerKey();
    const small = await seal(key, entryIdentity("e1"), utf8(JSON.stringify({ amount: 50, comment: "" })));
    const big = await seal(key, entryIdentity("e2"), utf8(JSON.stringify({ amount: 1250000000, comment: "" })));
    expect(small.ciphertext.length).toBe(big.ciphertext.length);
    expect(small.ciphertext.length).toBe(BUCKET_BYTES.entry + 16);
    const longComment = await seal(key, entryIdentity("e3"), utf8(JSON.stringify({ amount: 50, comment: "x".repeat(300) })));
    expect(longComment.ciphertext.length).toBe(2 * BUCKET_BYTES.entry + 16); // accepted leak: comment length in 256 B steps
  });

  it("fails to open when moved to another row, line, drawer, author, key generation, record type or schema", async () => {
    const key = await generateDrawerKey();
    const id = entryIdentity("e1");
    const sealed = await seal(key, id, utf8("secret"));
    const moves: Partial<RecordIdentity>[] = [
      { record_id: "e2" },
      { line_id: "other-line" },
      { drawer_id: "other-drawer" },
      { author_id: "other-user" },
      { key_version: 2 },
      { record_type: "document", line_id: null },
    ];
    for (const m of moves) {
      await expect(open(key, entryIdentity("e1", m), sealed)).rejects.toBeInstanceOf(AuthTagMismatch);
    }
    await expect(open(key, entryIdentity("e1", { schema_version: 99 }), sealed)).rejects.toBeInstanceOf(UnknownSchemaVersion);
  });

  it("refuses to seal under a schema version other than the current one", async () => {
    const key = await generateDrawerKey();
    await expect(seal(key, entryIdentity("e1", { schema_version: 2 }), utf8("x"))).rejects.toBeInstanceOf(InvalidPayload);
  });

  it("fails on a flipped ciphertext byte, a flipped nonce byte, and a wrong key", async () => {
    const key = await generateDrawerKey();
    const id = entryIdentity("e1");
    const sealed = await seal(key, id, utf8("secret"));
    const ct = new Uint8Array(sealed.ciphertext); ct[10] = (ct[10] ?? 0) ^ 1;
    await expect(open(key, id, { nonce: sealed.nonce, ciphertext: ct })).rejects.toBeInstanceOf(AuthTagMismatch);
    const nonce = new Uint8Array(sealed.nonce); nonce[0] = (nonce[0] ?? 0) ^ 1;
    await expect(open(key, id, { nonce, ciphertext: sealed.ciphertext })).rejects.toBeInstanceOf(AuthTagMismatch);
    await expect(open(await generateDrawerKey(), id, sealed)).rejects.toBeInstanceOf(AuthTagMismatch);
  });

  it("errors carry ids and versions but never content", async () => {
    const key = await generateDrawerKey();
    const id = entryIdentity("e1");
    const sealed = await seal(key, id, utf8("SECRET-TEXT"));
    try {
      await open(key, entryIdentity("e2"), sealed);
      expect.unreachable();
    } catch (e) {
      const err = e as AuthTagMismatch;
      expect(err.code).toBe("AuthTagMismatch");
      expect(err.context).toEqual({ record_type: "entry", record_id: "e2", drawer_id: DRAWER, line_id: LINE, author_id: AUTHOR, key_version: 1, schema_version: 1 });
      const dump = JSON.stringify(err) + err.message + String(err.stack) + JSON.stringify(Object.getOwnPropertyNames(err).map((k) => (err as unknown as Record<string, unknown>)[k]));
      expect(dump).not.toContain("SECRET-TEXT");
      expect(dump).not.toContain(toHex(sealed.ciphertext).slice(0, 16));
    }
  });

  it("rejects malformed identities before touching the key", async () => {
    const key = await generateDrawerKey();
    await expect(seal(key, entryIdentity("e1", { line_id: null }), utf8("x"))).rejects.toBeInstanceOf(InvalidPayload);
    await expect(seal(key, entryIdentity("e1", { record_type: "document" }), utf8("x"))).rejects.toBeInstanceOf(InvalidPayload);
    await expect(seal(key, entryIdentity("e1", { key_version: 0 }), utf8("x"))).rejects.toBeInstanceOf(InvalidPayload);
    await expect(seal(key, entryIdentity("e1", { author_id: "" }), utf8("x"))).rejects.toBeInstanceOf(InvalidPayload);
    await expect(seal(key, entryIdentity("", {}), utf8("x"))).rejects.toBeInstanceOf(InvalidPayload);
  });
});

describe("reseal (key rotation)", () => {
  it("moves a row to the next key generation; old key no longer opens it", async () => {
    const k1 = await generateDrawerKey();
    const k2 = await generateDrawerKey();
    const id = entryIdentity("e1");
    const sealed = await seal(k1, id, utf8("payload"));
    const r = await reseal(k1, k2, id, sealed, 2);
    expect(r.identity.key_version).toBe(2);
    expect(fromUtf8(await open(k2, r.identity, r.sealed))).toBe("payload");
    await expect(open(k1, r.identity, r.sealed)).rejects.toBeInstanceOf(AuthTagMismatch);
    await expect(open(k2, id, r.sealed)).rejects.toBeInstanceOf(AuthTagMismatch);
    await expect(reseal(k1, k2, id, sealed, 1)).rejects.toBeInstanceOf(InvalidPayload);
  });
});
