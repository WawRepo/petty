import { InvalidPayload, UnknownSchemaVersion, WrongPassphrase } from "./errors.js";
import { canonicalJson, fromB64, fromUtf8, lengthPrefixed, randomBytes, toB64, utf8, type Bytes } from "./encoding.js";
import { hkdfAesKey } from "./kdf.js";

const subtle = crypto.subtle;

/**
 * Access tokens (PETTY-164). The owner hands one of their own tools a token
 * `petty_pat_<id>.<secret>`. Only `<id>` is ever sent to the server, as the API credential;
 * `<secret>` never leaves the tool. It derives the key that opens a **bundle**: the drawer
 * keys the owner chose, and the signing key when the token may write as them.
 *
 * The server stores the sealed bundle and cannot open it, which is the whole point: a token
 * is a copy of the owner's keys, made by the owner, for a machine the owner runs.
 *
 * The bundle never holds the vault passphrase, the recovery vault or the ECDH private key, so
 * a token cannot replace the vault, read a wrap made for someone else, or take over the account.
 */
export const PAT_SECRET_BYTES = 32;
export const PAT_SCHEMA_VERSION = 1 as const;
const PAT_DOMAIN = "petty/pat/v1";

/** One drawer key, as raw AES-256 bytes, for the key version it belongs to. */
export interface PatDrawerKey {
  readonly drawer_id: string;
  readonly key_version: number;
  /** base64 raw AES-256-GCM key */
  readonly key: string;
}

export interface PatBundleV1 {
  readonly v: 1;
  readonly user_id: string;
  readonly drawers: readonly PatDrawerKey[];
  /** base64 PKCS#8 ECDSA P-256 private key; present only for a token that may write as the owner. */
  readonly ecdsa?: string;
}

/** What the server stores next to the token row: a nonce and the sealed bundle, both base64. */
export interface SealedPatBundle {
  readonly nonce: string;
  readonly ciphertext: string;
}

export const patSecret = (): Bytes => randomBytes(PAT_SECRET_BYTES);

function aad(tokenId: string, userId: string): Bytes {
  return lengthPrefixed([utf8(PAT_DOMAIN), utf8(tokenId), utf8(userId), utf8(String(PAT_SCHEMA_VERSION))]);
}

async function bundleKey(secret: Bytes, tokenId: string, userId: string): Promise<CryptoKey> {
  if (secret.length !== PAT_SECRET_BYTES) throw new InvalidPayload("pat.secret");
  if (!tokenId || !userId) throw new InvalidPayload("pat.identity");
  // hkdfAesKey zeroes what it is given, and the caller keeps using its secret: derive from a copy.
  return hkdfAesKey(new Uint8Array(secret), utf8(PAT_DOMAIN), utf8(`${tokenId}\0${userId}`), "AES-GCM", ["encrypt", "decrypt"]);
}

export async function sealPatBundle(secret: Bytes, tokenId: string, bundle: PatBundleV1): Promise<SealedPatBundle> {
  if (bundle.v !== 1) throw new InvalidPayload("pat.bundle.v");
  if (!bundle.user_id) throw new InvalidPayload("pat.bundle.user_id");
  const key = await bundleKey(secret, tokenId, bundle.user_id);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(tokenId, bundle.user_id) }, key, utf8(canonicalJson(bundle))),
  );
  return { nonce: toB64(nonce), ciphertext: toB64(ct) };
}

/**
 * Open a bundle. A wrong secret, another token's id or another user's id all fail the same
 * way: the AES-GCM tag does not verify, so nothing is learned from the error.
 */
export async function openPatBundle(secret: Bytes, tokenId: string, userId: string, sealed: SealedPatBundle): Promise<PatBundleV1> {
  const key = await bundleKey(secret, tokenId, userId);
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(sealed.nonce), additionalData: aad(tokenId, userId) },
      key,
      fromB64(sealed.ciphertext),
    );
  } catch {
    throw new WrongPassphrase();
  }
  const parsed: unknown = JSON.parse(fromUtf8(new Uint8Array(plain)));
  if (typeof parsed !== "object" || parsed === null) throw new InvalidPayload("pat.bundle");
  const b = parsed as PatBundleV1;
  if (b.v !== 1) throw new UnknownSchemaVersion({ v: String((b as { v: unknown }).v) });
  if (b.user_id !== userId) throw new InvalidPayload("pat.bundle.user_id");
  if (!Array.isArray(b.drawers)) throw new InvalidPayload("pat.bundle.drawers");
  for (const d of b.drawers) {
    if (!d || typeof d.drawer_id !== "string" || !d.drawer_id) throw new InvalidPayload("pat.bundle.drawer_id");
    if (!Number.isInteger(d.key_version) || d.key_version < 1) throw new InvalidPayload("pat.bundle.key_version");
    if (typeof d.key !== "string" || fromB64(d.key).length !== 32) throw new InvalidPayload("pat.bundle.key");
  }
  if (b.ecdsa !== undefined && typeof b.ecdsa !== "string") throw new InvalidPayload("pat.bundle.ecdsa");
  return b;
}

/** The token string the owner copies. Split on the first dot: the left half is the credential. */
export const patToken = (tokenId: string, secret: Bytes): string => `petty_pat_${tokenId}.${toB64(secret)}`;

export function splitPatToken(token: string): { tokenId: string; secret: Bytes } {
  const m = /^petty_pat_([A-Za-z0-9_-]{16,128})\.([A-Za-z0-9+/=_-]{16,256})$/.exec(token.trim());
  if (!m) throw new InvalidPayload("pat.token");
  const secret = fromB64(m[2]!);
  if (secret.length !== PAT_SECRET_BYTES) throw new InvalidPayload("pat.token.secret");
  return { tokenId: m[1]!, secret };
}
