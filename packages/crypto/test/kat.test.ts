/**
 * Known-answer tests against published vectors. If any of these fail, the
 * platform's WebCrypto or hash-wasm is broken — nothing else in this package
 * can be trusted until they pass.
 */
import { describe, expect, it } from "vitest";
import { fromHex, hkdfDerive, sha256, toHex, utf8 } from "../src/index.js";
import { argon2idRaw } from "../src/testing.js";

const subtle = crypto.subtle;

describe("SHA-256 (FIPS 180-4)", () => {
  it("abc", async () => {
    expect(toHex(await sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("AES-256-GCM (McGrew–Viega test cases 13, 14, 16)", () => {
  async function gcm(keyHex: string, ivHex: string, ptHex: string, aadHex: string) {
    const key = await subtle.importKey("raw", fromHex(keyHex), "AES-GCM", false, ["encrypt"]);
    const out = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: fromHex(ivHex), additionalData: fromHex(aadHex), tagLength: 128 }, key, fromHex(ptHex)));
    return { ct: toHex(out.subarray(0, out.length - 16)), tag: toHex(out.subarray(out.length - 16)) };
  }
  it("TC13: empty plaintext", async () => {
    const r = await gcm("00".repeat(32), "00".repeat(12), "", "");
    expect(r.ct).toBe("");
    expect(r.tag).toBe("530f8afbc74536b9a963b4f1c4cb738b");
  });
  it("TC14: one zero block", async () => {
    const r = await gcm("00".repeat(32), "00".repeat(12), "00".repeat(16), "");
    expect(r.ct).toBe("cea7403d4d606b6e074ec5d3baf39d18");
    expect(r.tag).toBe("d0d1c8a799996bf0265b98b5d48ab919");
  });
  it("TC16: with AAD", async () => {
    const r = await gcm(
      "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
      "cafebabefacedbaddecaf888",
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
      "feedfacedeadbeeffeedfacedeadbeefabaddad2",
    );
    expect(r.ct).toBe("522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662");
    expect(r.tag).toBe("76fc6ece0f4e1768cddf8853bb2d551b");
  });
});

describe("HKDF-SHA256 (RFC 5869 test case 1)", () => {
  it("derives the published OKM", async () => {
    const okm = await hkdfDerive(fromHex("0b".repeat(22)), fromHex("000102030405060708090a0b0c"), fromHex("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect(toHex(okm)).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });
});

describe("Argon2id v1.3 (reference implementation test vectors)", () => {
  it("t=2, m=256 KiB, p=1", async () => {
    const out = await argon2idRaw("password", utf8("somesalt"), { t: 2, m: 256, p: 1 });
    expect(toHex(out)).toBe("9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe");
  });
  it("t=2, m=64 MiB, p=1", async () => {
    const out = await argon2idRaw("password", utf8("somesalt"), { t: 2, m: 65536, p: 1 });
    expect(toHex(out)).toBe("09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7");
  }, 30_000);
});

describe("AES-KW (RFC 3394 §4.6: 256-bit key data, 256-bit KEK)", () => {
  it("wraps to the published output", async () => {
    const kek = await subtle.importKey("raw", fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), "AES-KW", false, ["wrapKey"]);
    const data = await subtle.importKey("raw", fromHex("00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f"), "AES-GCM", true, ["encrypt"]);
    expect(toHex(new Uint8Array(await subtle.wrapKey("raw", data, kek, "AES-KW")))).toBe("28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21");
  });
});

describe("ECDH P-256 (RFC 5903 §8.1)", () => {
  it("derives the published shared secret", async () => {
    const b64u = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
    const iPriv = await subtle.importKey("jwk", {
      kty: "EC", crv: "P-256",
      d: b64u("c88f01f510d9ac3f70a292daa2316de544e9aab8afe84049c62a9c57862d1433"),
      x: b64u("dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c3772581180"),
      y: b64u("5271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb3"),
    }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const rPub = await subtle.importKey("raw", fromHex("04d12dfb5289c8d4f81208b70270398c342296970a0bccb74c736fc7554494bf6356fbf3ca366cc23e8157854c13c58d6aac23f046ada30f8353e74f33039872ab"), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: rPub }, iPriv, 256));
    expect(toHex(shared)).toBe("d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de");
  });
});

describe("ECDSA P-256 / SHA-256 verify (RFC 6979 A.2.5, message \"sample\")", () => {
  it("accepts the published signature and rejects a flipped bit", async () => {
    const pub = await subtle.importKey("raw", fromHex("0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = fromHex("efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8");
    expect(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, utf8("sample"))).toBe(true);
    const bad = new Uint8Array(sig); bad[0] = (bad[0] ?? 0) ^ 1;
    expect(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, bad, utf8("sample"))).toBe(false);
    expect(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, utf8("sampl"))).toBe(false);
  });
});
