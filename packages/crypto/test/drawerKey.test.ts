import { describe, expect, it } from "vitest";
import { AuthTagMismatch, InvalidPayload, KeyNotExtractable, SenderKeyMismatch, UnwrapFailed, createDrawerKey, exportPublicKeys, fromB64, generateDrawerKey, generateUserKeys, open, seal, toB64, unwrapDrawerKey, wrapDrawerKey, utf8, fromUtf8, type Sender } from "../src/index.js";
import { DRAWER, entryIdentity } from "./helpers.js";

async function member() {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const sender: Sender = { ecdhPrivate: keys.ecdh.privateKey, ecdhPublicB64: pub.ecdh };
  return { keys, pub, sender };
}
const expect1 = (senderPub: string, key_version = 1, drawer_id = DRAWER) => ({ drawer_id, key_version, senderEcdhPublicB64: senderPub });

describe("drawer key wrapping", () => {
  it("owner wraps for a member; member unwraps with the PINNED sender key and decrypts; non-member cannot", async () => {
    const alice = await member();
    const bob = await member();
    const mallory = await member();
    const drawerKey = await generateDrawerKey({ extractable: true });
    const sealed = await seal(drawerKey, entryIdentity("e1"), utf8("cash"));

    const wrapForBob = await wrapDrawerKey(drawerKey, alice.sender, bob.pub.ecdh, DRAWER, 1);
    const bobsKey = await unwrapDrawerKey(wrapForBob, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh));
    expect(bobsKey.extractable).toBe(false);
    expect(fromUtf8(await open(bobsKey, entryIdentity("e1"), sealed))).toBe("cash");

    await expect(unwrapDrawerKey(wrapForBob, mallory.keys.ecdh.privateKey, expect1(alice.pub.ecdh))).rejects.toBeInstanceOf(UnwrapFailed);
  });

  it("a server-substituted sender key is refused: the wrap's carried key must equal the pinned key, and the pinned key is what is used", async () => {
    const alice = await member();
    const bob = await member();
    const server = await member();
    // The server forges a wrap of a key IT knows, claiming to be from alice.
    const evilKey = await generateDrawerKey({ extractable: true });
    const forged = await wrapDrawerKey(evilKey, server.sender, bob.pub.ecdh, DRAWER, 2);
    // Bob pins alice's real key → carried key mismatch is detected loudly.
    await expect(unwrapDrawerKey(forged, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh, 2))).rejects.toBeInstanceOf(SenderKeyMismatch);
    // Even if the server also rewrites the carried field to alice's key, ECDH runs against the pinned key and fails.
    await expect(unwrapDrawerKey({ ...forged, sender_ecdh_pub: alice.pub.ecdh }, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh, 2))).rejects.toBeInstanceOf(UnwrapFailed);
  });

  it("a wrap is bound to its drawer and key version, and the caller must state which it expects", async () => {
    const alice = await member();
    const bob = await member();
    const drawerKey = await generateDrawerKey({ extractable: true });
    const w = await wrapDrawerKey(drawerKey, alice.sender, bob.pub.ecdh, DRAWER, 1);
    await expect(unwrapDrawerKey(w, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh, 1, "other"))).rejects.toBeInstanceOf(InvalidPayload);
    await expect(unwrapDrawerKey(w, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh, 2))).rejects.toBeInstanceOf(InvalidPayload);
    await expect(unwrapDrawerKey({ ...w, drawer_id: "other" }, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh, 1, "other"))).rejects.toBeInstanceOf(UnwrapFailed);
    await expect(unwrapDrawerKey({ ...w, key_version: 2 }, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh, 2))).rejects.toBeInstanceOf(UnwrapFailed);
    const bytes = fromB64(w.wrapped); bytes[5] = (bytes[5] ?? 0) ^ 1;
    await expect(unwrapDrawerKey({ ...w, wrapped: toB64(bytes) }, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh))).rejects.toBeInstanceOf(UnwrapFailed);
    await expect(unwrapDrawerKey(w, bob.keys.ecdh.privateKey, { ...expect1(alice.pub.ecdh), senderEcdhPublicB64: "" })).rejects.toBeInstanceOf(InvalidPayload);
  });

  it("createDrawerKey returns a non-extractable handle and a self-wrap that round-trips", async () => {
    const alice = await member();
    const { key, selfWrap } = await createDrawerKey(alice.sender, DRAWER, 1);
    expect(key.extractable).toBe(false);
    expect(selfWrap.key_version).toBe(1);
    const sealed = await seal(key, entryIdentity("e1"), utf8("x"));
    const again = await unwrapDrawerKey(selfWrap, alice.keys.ecdh.privateKey, expect1(alice.pub.ecdh));
    expect(fromUtf8(await open(again, entryIdentity("e1"), sealed))).toBe("x");
  });

  it("re-wrapping needs an extractable unwrap, which is opt-in and short-lived", async () => {
    const alice = await member();
    const bob = await member();
    const { key, selfWrap } = await createDrawerKey(alice.sender, DRAWER, 1);
    await expect(wrapDrawerKey(key, alice.sender, bob.pub.ecdh, DRAWER, 1)).rejects.toBeInstanceOf(KeyNotExtractable);
    const unlocked = await unwrapDrawerKey(selfWrap, alice.keys.ecdh.privateKey, expect1(alice.pub.ecdh), { extractable: true });
    const w2 = await wrapDrawerKey(unlocked, alice.sender, bob.pub.ecdh, DRAWER, 1);
    const bobsKey = await unwrapDrawerKey(w2, bob.keys.ecdh.privateKey, expect1(alice.pub.ecdh));
    const sealed = await seal(key, entryIdentity("e1"), utf8("y"));
    expect(fromUtf8(await open(bobsKey, entryIdentity("e1"), sealed))).toBe("y");
    await expect(open(bobsKey, entryIdentity("e1", { key_version: 2 }), sealed)).rejects.toBeInstanceOf(AuthTagMismatch);
  });
});
