import { describe, expect, it } from "vitest";
import { AuthTagMismatch, InvalidPayload } from "../src/errors.js";
import { DEVICE_CODE_ALPHABET, deviceKeyPair, deviceUserCode, normalizeDeviceCode, openDeviceToken, sealDeviceToken } from "../src/device.js";

const ORIGIN = "https://petty.example.com";
const ctx = { requestId: "5f0c2a0e-6b1f-4f55-9d0a-1e2d3c4b5a69", userCode: "BCDF-GHJK-LMNP-QRST-VWXZ", origin: ORIGIN };
const TOKEN = "petty_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI=";

describe("device login (PETTY-274)", () => {
  it("derives a 20-letter code in five groups from the tool's key and the site's address: the same two, the same code", async () => {
    const { publicB64 } = await deviceKeyPair();
    const code = await deviceUserCode(publicB64, ORIGIN);
    expect(code).toMatch(new RegExp(`^[${DEVICE_CODE_ALPHABET}]{4}(-[${DEVICE_CODE_ALPHABET}]{4}){4}$`));
    await expect(deviceUserCode(publicB64, ORIGIN)).resolves.toBe(code);
  });

  // PETTY-451: these two codes were computed outside this code (SHA-256 over the length-prefixed domain,
  // address and key), so the command line and the page of every later version must agree on them
  it("keeps giving the known code for a known key and address", async () => {
    // a P-256 public point in SPKI form, made for this test; no private half is kept anywhere
    const spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMZunXezbk9lK3o0I4eiY83Tr2CBr8Eitpl3xwzJ/5IPeIQMDkrfGjYckjaD19XDJOXin1NVptC3a3v9ZU5ghKA==";
    await expect(deviceUserCode(spki, ORIGIN)).resolves.toBe("BPPG-QLRP-WZNQ-WWBJ-KLSQ");
    await expect(deviceUserCode(spki, "https://other.example.com")).resolves.toBe("SRNS-HWKH-SPNL-XQXH-CNHL");
  });

  it("gives another key another code, so a swapped key shows on the page", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add(await deviceUserCode((await deviceKeyPair()).publicB64, ORIGIN));
    expect(codes.size).toBe(20);
  });

  it("gives the same key another code at another address, and none without an address (PETTY-451)", async () => {
    const { publicB64 } = await deviceKeyPair();
    const here = await deviceUserCode(publicB64, ORIGIN);
    expect(await deviceUserCode(publicB64, "https://petty.example.org")).not.toBe(here);
    expect(await deviceUserCode(publicB64, "http://petty.example.com")).not.toBe(here);
    expect(await deviceUserCode(publicB64, "https://petty.example.com:8443")).not.toBe(here);
    await expect(deviceUserCode(publicB64, "")).rejects.toBeInstanceOf(InvalidPayload);
  });

  it("reads a code however it was typed, and refuses what cannot be one", () => {
    expect(normalizeDeviceCode("bcdf ghjk-lmnp qrst vwxz")).toBe("BCDF-GHJK-LMNP-QRST-VWXZ");
    expect(normalizeDeviceCode("BCDFGHJKLMNPQRSTVWXZ")).toBe("BCDF-GHJK-LMNP-QRST-VWXZ");
    expect(normalizeDeviceCode("BCDF-GHJK-LMNP-QRST-VWXA")).toBeNull(); // a vowel
    expect(normalizeDeviceCode("BCDF-GHJK-LMNP-QRST")).toBeNull();
    expect(normalizeDeviceCode("BCDF-GHJK-LMNP-QRST-VWXZ-B")).toBeNull();
    expect(normalizeDeviceCode("")).toBeNull();
  });

  it("does not read a code of the earlier 12-letter form as a code (PETTY-451)", () => {
    expect(normalizeDeviceCode("BCDF-GHJK-LMNP")).toBeNull();
    expect(normalizeDeviceCode("bcdf ghjk lmnp")).toBeNull();
  });

  it("seals a token that only the tool's private key opens, for this request, code and site", async () => {
    const tool = await deviceKeyPair();
    const sealed = await sealDeviceToken(tool.publicB64, TOKEN, ctx);
    expect(JSON.stringify(sealed)).not.toContain("petty_pat_");
    await expect(openDeviceToken(tool.privateKey, sealed, ctx)).resolves.toBe(TOKEN);

    const other = await deviceKeyPair();
    await expect(openDeviceToken(other.privateKey, sealed, ctx)).rejects.toBeInstanceOf(AuthTagMismatch);
    for (const moved of [{ ...ctx, requestId: "another" }, { ...ctx, userCode: "BCDF-GHJK-LMNP-QRST-VWXB" }, { ...ctx, origin: "https://evil.example" }]) {
      await expect(openDeviceToken(tool.privateKey, sealed, moved)).rejects.toBeInstanceOf(AuthTagMismatch);
    }
    const altered = { ...sealed, ciphertext: sealed.ciphertext.replace(/^./, (c) => (c === "A" ? "B" : "A")) };
    await expect(openDeviceToken(tool.privateKey, altered, ctx)).rejects.toBeInstanceOf(AuthTagMismatch);
  });

  it("uses a fresh key and nonce for every seal", async () => {
    const tool = await deviceKeyPair();
    const a = await sealDeviceToken(tool.publicB64, TOKEN, ctx);
    const b = await sealDeviceToken(tool.publicB64, TOKEN, ctx);
    expect(a.eph_pub).not.toBe(b.eph_pub);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses an empty context", async () => {
    const tool = await deviceKeyPair();
    await expect(sealDeviceToken(tool.publicB64, TOKEN, { ...ctx, origin: "" })).rejects.toBeInstanceOf(InvalidPayload);
  });
});
