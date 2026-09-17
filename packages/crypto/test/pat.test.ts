import { describe, expect, it } from "vitest";
import { InvalidPayload, WrongPassphrase } from "../src/errors.js";
import { randomBytes, toB64 } from "../src/encoding.js";
import { openPatBundle, patSecret, patToken, sealPatBundle, splitPatToken, type PatBundleV1 } from "../src/pat.js";

const bundle = (over: Partial<PatBundleV1> = {}): PatBundleV1 => ({
  v: 1,
  user_id: "user-1",
  drawers: [{ drawer_id: "drawer-1", key_version: 1, key: toB64(randomBytes(32)) }],
  ...over,
});

describe("access token bundle (PETTY-164)", () => {
  it("opens with the right secret, token id and user id", async () => {
    const secret = patSecret();
    const b = bundle();
    const sealed = await sealPatBundle(secret, "tok-1", b);
    await expect(openPatBundle(secret, "tok-1", "user-1", sealed)).resolves.toEqual(b);
  });

  it("fails on a wrong secret, another token id or another user id", async () => {
    const secret = patSecret();
    const sealed = await sealPatBundle(secret, "tok-1", bundle());
    await expect(openPatBundle(patSecret(), "tok-1", "user-1", sealed)).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(openPatBundle(secret, "tok-2", "user-1", sealed)).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(openPatBundle(secret, "tok-1", "user-2", sealed)).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it("carries the signing key only when the token may write", async () => {
    const secret = patSecret();
    const ecdsa = toB64(randomBytes(138));
    const sealed = await sealPatBundle(secret, "tok-1", bundle({ ecdsa }));
    const open = await openPatBundle(secret, "tok-1", "user-1", sealed);
    expect(open.ecdsa).toBe(ecdsa);
    const readOnly = await openPatBundle(secret, "tok-1", "user-1", await sealPatBundle(secret, "tok-1", bundle()));
    expect(readOnly.ecdsa).toBeUndefined();
  });

  it("the sealed bundle shows no drawer id or key in the clear", async () => {
    const secret = patSecret();
    const b = bundle();
    const sealed = await sealPatBundle(secret, "tok-1", b);
    expect(sealed.ciphertext).not.toContain("drawer-1");
    expect(sealed.ciphertext).not.toContain(b.drawers[0]!.key);
  });

  it("splits the token string and refuses a broken one", () => {
    const secret = patSecret();
    const token = patToken("tok-1234567890abcdef", secret);
    const split = splitPatToken(token);
    expect(split.tokenId).toBe("tok-1234567890abcdef");
    expect(toB64(split.secret)).toBe(toB64(secret));
    expect(() => splitPatToken("nope")).toThrow(InvalidPayload);
    expect(() => splitPatToken(`petty_pat_tok-1234567890abcdef.${toB64(randomBytes(8))}`)).toThrow(InvalidPayload);
  });
});
