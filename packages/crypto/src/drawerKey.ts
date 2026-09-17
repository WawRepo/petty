import { InvalidPayload, KeyNotExtractable, SenderKeyMismatch, UnwrapFailed } from "./errors.js";
import { copy, fromB64, lengthPrefixed, randomBytes, toB64, utf8, zero } from "./encoding.js";
import { hkdfAesKey } from "./kdf.js";
import { importEcdhPublic } from "./keys.js";
import { generateDrawerKey } from "./seal.js";

const subtle = crypto.subtle;

/**
 * A drawer key wrapped for one member. Static-static ECDH between the sender's
 * private key and the recipient's public key → HKDF (salted, info bound to the
 * drawer and key generation) → AES-KW.
 *
 * The recipient reverses it with their own private key and the sender's public
 * key. That public key comes from the recipient's PINNED keys for the sender,
 * never from the wrap or the server: a server that could choose the sender key
 * could hand out a drawer key it knows. `sender_ecdh_pub` is kept on the wrap
 * only so the recipient can detect and report a substitution.
 */
export interface DrawerKeyWrapV1 {
  readonly v: 1;
  readonly drawer_id: string;
  readonly key_version: number;
  /** base64 SPKI of the sender's ECDH public key as the sender saw it. Informational; must equal the pinned key. */
  readonly sender_ecdh_pub: string;
  readonly salt: string;
  readonly wrapped: string;
}

export interface Sender {
  readonly ecdhPrivate: CryptoKey;
  readonly ecdhPublicB64: string;
}

async function wrapKek(myPrivate: CryptoKey, theirPublic: CryptoKey, salt: Uint8Array, drawerId: string, keyVersion: number): Promise<CryptoKey> {
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: theirPublic }, myPrivate, 256));
  try {
    const info = lengthPrefixed([utf8("petty/drawer-key-wrap/v1"), utf8(drawerId), utf8(String(keyVersion))]);
    return await hkdfAesKey(shared, salt, info, "AES-KW", ["wrapKey", "unwrapKey"]);
  } finally {
    zero(shared);
  }
}

function assertIds(drawerId: string, keyVersion: number): void {
  if (typeof drawerId !== "string" || drawerId.length === 0) throw new InvalidPayload("drawer_id");
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new InvalidPayload("key_version");
}

export async function wrapDrawerKey(
  drawerKey: CryptoKey,
  sender: Sender,
  recipientEcdhPublicB64: string,
  drawerId: string,
  keyVersion: number,
): Promise<DrawerKeyWrapV1> {
  assertIds(drawerId, keyVersion);
  if (!drawerKey.extractable) throw new KeyNotExtractable({ drawer_id: drawerId, key_version: keyVersion });
  const recipient = await importEcdhPublic(recipientEcdhPublicB64);
  const salt = randomBytes(32);
  const kek = await wrapKek(sender.ecdhPrivate, recipient, salt, drawerId, keyVersion);
  const wrapped = new Uint8Array(await subtle.wrapKey("raw", drawerKey, kek, "AES-KW"));
  return { v: 1, drawer_id: drawerId, key_version: keyVersion, sender_ecdh_pub: sender.ecdhPublicB64, salt: toB64(salt), wrapped: toB64(wrapped) };
}

export interface Expected {
  /** The drawer this wrap was fetched for. */
  readonly drawer_id: string;
  /** The key generation this wrap was fetched for. */
  readonly key_version: number;
  /** The sender's ECDH public key from the recipient's pinned keys. Required. */
  readonly senderEcdhPublicB64: string;
}

export interface UnwrapDrawerKeyOptions {
  /** Only when this key must be wrapped for someone else right now. Default false. */
  readonly extractable?: boolean;
}

export async function unwrapDrawerKey(wrap: DrawerKeyWrapV1, recipientEcdhPrivate: CryptoKey, expected: Expected, opts: UnwrapDrawerKeyOptions = {}): Promise<CryptoKey> {
  assertIds(expected.drawer_id, expected.key_version);
  const ctx = { drawer_id: expected.drawer_id, key_version: expected.key_version };
  if (wrap.v !== 1) throw new InvalidPayload("wrap version", ctx);
  if (wrap.drawer_id !== expected.drawer_id || wrap.key_version !== expected.key_version) throw new InvalidPayload("wrap identity", ctx);
  if (typeof expected.senderEcdhPublicB64 !== "string" || expected.senderEcdhPublicB64.length === 0) throw new InvalidPayload("pinned sender key", ctx);
  if (wrap.sender_ecdh_pub !== expected.senderEcdhPublicB64) throw new SenderKeyMismatch(ctx);
  const sender = await importEcdhPublic(expected.senderEcdhPublicB64);
  const kek = await wrapKek(recipientEcdhPrivate, sender, fromB64(wrap.salt), expected.drawer_id, expected.key_version);
  try {
    return await subtle.unwrapKey("raw", copy(fromB64(wrap.wrapped)), kek, "AES-KW", { name: "AES-GCM", length: 256 }, opts.extractable ?? false, ["encrypt", "decrypt"]);
  } catch {
    throw new UnwrapFailed(ctx);
  }
}

/**
 * The normal way to make a drawer key (new drawer, or a rotation): generate it,
 * wrap it for the creator, and return a NON-extractable handle plus the self-wrap.
 * The extractable handle never leaves this function.
 */
export async function createDrawerKey(creator: Sender, drawerId: string, keyVersion: number): Promise<{ key: CryptoKey; selfWrap: DrawerKeyWrapV1 }> {
  const extractable = await generateDrawerKey({ extractable: true });
  const selfWrap = await wrapDrawerKey(extractable, creator, creator.ecdhPublicB64, drawerId, keyVersion);
  const key = await unwrapDrawerKey(selfWrap, creator.ecdhPrivate, { drawer_id: drawerId, key_version: keyVersion, senderEcdhPublicB64: creator.ecdhPublicB64 });
  return { key, selfWrap };
}
