import { describe, expect, it } from "vitest";
import { AuthTagMismatch, InvalidPayload } from "../src/errors.js";
import { DEVICE_CODE_ALPHABET, deviceKeyPair, deviceUserCode, normalizeDeviceCode, openDeviceToken, sealDeviceToken } from "../src/device.js";

const ctx = { requestId: "5f0c2a0e-6b1f-4f55-9d0a-1e2d3c4b5a69", userCode: "BCDF-GHJK-LMNP", origin: "https://petty.example.com" };
const TOKEN = "petty_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI=";

describe("device login (PETTY-274)", () => {
  it("derives a 12-letter code in three groups from the tool's key: the same key, the same code", async () => {
    const { publicB64 } = await deviceKeyPair();
    const code = await deviceUserCode(publicB64);
    expect(code).toMatch(new RegExp(`^[${DEVICE_CODE_ALPHABET}]{4}-[${DEVICE_CODE_ALPHABET}]{4}-[${DEVICE_CODE_ALPHABET}]{4}$`));
    await expect(deviceUserCode(publicB64)).resolves.toBe(code);
  });

  it("gives another key another code, so a swapped key shows on the page", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add(await deviceUserCode((await deviceKeyPair()).publicB64));
    expect(codes.size).toBe(20);
  });

  it("reads a code however it was typed, and refuses what cannot be one", () => {
    expect(normalizeDeviceCode("bcdf ghjk-lmnp")).toBe("BCDF-GHJK-LMNP");
    expect(normalizeDeviceCode("BCDFGHJKLMNP")).toBe("BCDF-GHJK-LMNP");
    expect(normalizeDeviceCode("BCDF-GHJK-LMNA")).toBeNull(); // a vowel
    expect(normalizeDeviceCode("BCDF-GHJK")).toBeNull();
    expect(normalizeDeviceCode("")).toBeNull();
  });

  it("seals a token that only the tool's private key opens, for this request, code and site", async () => {
    const tool = await deviceKeyPair();
    const sealed = await sealDeviceToken(tool.publicB64, TOKEN, ctx);
    expect(JSON.stringify(sealed)).not.toContain("petty_pat_");
    await expect(openDeviceToken(tool.privateKey, sealed, ctx)).resolves.toBe(TOKEN);

    const other = await deviceKeyPair();
    await expect(openDeviceToken(other.privateKey, sealed, ctx)).rejects.toBeInstanceOf(AuthTagMismatch);
    for (const moved of [{ ...ctx, requestId: "another" }, { ...ctx, userCode: "BCDF-GHJK-LMNQ" }, { ...ctx, origin: "https://evil.example" }]) {
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
