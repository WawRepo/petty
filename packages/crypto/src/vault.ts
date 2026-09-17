import { InvalidPayload, UnknownSchemaVersion, WrongPassphrase } from "./errors.js";
import { fromB64, lengthPrefixed, randomBytes, toB64, utf8, type Bytes } from "./encoding.js";
import { ARGON2ID_V1, argon2idAesGcmKek, assertArgon2Params, assertSalt, hkdfAesKey } from "./kdf.js";
import { exportPublicKeys, importEcdhPublic, importEcdsaPublic, type PublicKeys, type UserKeyPairs } from "./keys.js";

const subtle = crypto.subtle;

/**
 * Private-key custody. Both private keys are wrapped with AES-256-GCM under a
 * key-encryption key (KEK) derived from either the vault passphrase (Argon2id) or
 * the recovery code (HKDF — the code already has 150 bits of entropy).
 *
 * The AAD of each wrap binds `kind`, the slot, and BOTH public keys, so a server
 * that swaps `pub` in the stored blob makes the blob fail to open instead of
 * making the user display an attacker's safety number as their own.
 *
 * Deviation from the spec's "AES-KW to wrap": AES-KW needs input that is a
 * multiple of 8 bytes and PKCS#8 EC private keys are not, so browsers reject it.
 * AES-KW is still used where the spec's reason applies — wrapping raw AES drawer keys.
 */
export interface WrappedPrivateKeyV1 {
  readonly iv: string;
  readonly ct: string;
}
export type VaultKdf =
  | { readonly name: "argon2id"; readonly m: number; readonly t: number; readonly p: number; readonly salt: string }
  | { readonly name: "hkdf-sha256"; readonly salt: string }
  /** Passkey: the 32-byte WebAuthn PRF output is the input keying material. */
  | { readonly name: "prf-hkdf-sha256"; readonly salt: string };

export type VaultKind = "passphrase" | "recovery" | "passkey";
/** Which KDF a vault of each kind must use; a blob whose pair disagrees is rejected before any KDF runs. */
const KDF_FOR_KIND: Record<VaultKind, VaultKdf["name"]> = { passphrase: "argon2id", recovery: "hkdf-sha256", passkey: "prf-hkdf-sha256" };
export const PRF_OUTPUT_BYTES = 32;

export interface VaultBlobV1 {
  readonly v: 1;
  readonly kind: VaultKind;
  readonly kdf: VaultKdf;
  readonly pub: PublicKeys;
  readonly ecdh: WrappedPrivateKeyV1;
  readonly ecdsa: WrappedPrivateKeyV1;
}

export interface UnlockedKeys {
  readonly ecdhPrivate: CryptoKey;
  readonly ecdsaPrivate: CryptoKey;
  readonly pub: PublicKeys;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

export const PASSPHRASE_MIN_LENGTH = 12;

function normalizePassphrase(p: string): string {
  return p.normalize("NFKC");
}

function slotAad(kind: VaultBlobV1["kind"], slot: "ecdh" | "ecdsa", pub: PublicKeys) {
  return lengthPrefixed([utf8("petty/vault/v1"), utf8(kind), utf8(slot), utf8(pub.ecdh), utf8(pub.ecdsa)]);
}

type VaultSecret = string | Uint8Array;

async function kekFor(kdf: VaultKdf, secret: VaultSecret): Promise<CryptoKey> {
  const salt = fromB64(kdf.salt);
  assertSalt(salt);
  if (kdf.name === "argon2id") {
    if (typeof secret !== "string") throw new InvalidPayload("secret type");
    assertArgon2Params(kdf);
    return argon2idAesGcmKek(normalizePassphrase(secret), salt, kdf);
  }
  if (kdf.name === "hkdf-sha256") {
    if (typeof secret !== "string") throw new InvalidPayload("secret type");
    return hkdfAesKey(utf8(normalizeRecoveryCode(secret)), salt, utf8("petty/recovery-kek/v1"), "AES-GCM", ["wrapKey", "unwrapKey"]);
  }
  if (kdf.name === "prf-hkdf-sha256") {
    if (typeof secret === "string" || secret.length !== PRF_OUTPUT_BYTES) throw new InvalidPayload("prf output");
    return hkdfAesKey(new Uint8Array(secret), salt, utf8("petty/passkey-kek/v1"), "AES-GCM", ["wrapKey", "unwrapKey"]);
  }
  throw new InvalidPayload("kdf name");
}

async function wrapPrivate(kek: CryptoKey, aad: Bytes, key: CryptoKey): Promise<WrappedPrivateKeyV1> {
  const iv = randomBytes(12);
  const ct = await subtle.wrapKey("pkcs8", key, kek, { name: "AES-GCM", iv, additionalData: aad });
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

async function createBlob(kind: VaultBlobV1["kind"], kdf: VaultKdf, secret: VaultSecret, keys: UserKeyPairs): Promise<VaultBlobV1> {
  const kek = await kekFor(kdf, secret);
  const pub = await exportPublicKeys(keys);
  return {
    v: 1,
    kind,
    kdf,
    pub,
    ecdh: await wrapPrivate(kek, slotAad(kind, "ecdh", pub), keys.ecdh.privateKey),
    ecdsa: await wrapPrivate(kek, slotAad(kind, "ecdsa", pub), keys.ecdsa.privateKey),
  };
}

/** Wrap freshly generated keys under the vault passphrase. Only ever called with keys from `generateUserKeys` or an `extractable: true` unlock. */
export async function createVault(passphrase: string, keys: UserKeyPairs): Promise<VaultBlobV1> {
  if (normalizePassphrase(passphrase).length < PASSPHRASE_MIN_LENGTH) throw new InvalidPayload("passphrase length");
  const kdf: VaultKdf = { ...ARGON2ID_V1, salt: toB64(randomBytes(16)) };
  return createBlob("passphrase", kdf, passphrase, keys);
}

/** Second copy of the same keys, wrapped under the recovery code. */
export async function createRecoveryVault(recoveryCode: string, keys: UserKeyPairs): Promise<VaultBlobV1> {
  if (normalizeRecoveryCode(recoveryCode).length !== RECOVERY_CODE_CHARS) throw new InvalidPayload("recovery code");
  const kdf: VaultKdf = { name: "hkdf-sha256", salt: toB64(randomBytes(16)) };
  return createBlob("recovery", kdf, recoveryCode, keys);
}

/**
 * Third copy of the same keys, wrapped under a key derived from a WebAuthn PRF
 * output (Face ID / Touch ID / security key). The PRF output never leaves the
 * device and the authenticator only produces it after user verification.
 */
export async function createPasskeyVault(prfOutput: Uint8Array, keys: UserKeyPairs): Promise<VaultBlobV1> {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) throw new InvalidPayload("prf output");
  const kdf: VaultKdf = { name: "prf-hkdf-sha256", salt: toB64(randomBytes(16)) };
  return createBlob("passkey", kdf, prfOutput, keys);
}

export interface UnlockOptions {
  /** Only for re-wrapping (passphrase change, new recovery code). Default false: keys cannot leave WebCrypto. */
  readonly extractable?: boolean;
}

const SELF_CHECK = utf8("petty/vault/v1/self-check");

/** Opens a passphrase or recovery vault. Passkey vaults go through `unlockPasskeyVault`. */
export async function unlockVault(blob: VaultBlobV1, secret: string, opts: UnlockOptions = {}): Promise<UnlockedKeys> {
  if (blob.kind === "passkey") throw new InvalidPayload("vault kind");
  return unlockWith(blob, secret, opts);
}

/** Opens a passkey vault with the 32-byte PRF output of `navigator.credentials.get`. */
export async function unlockPasskeyVault(blob: VaultBlobV1, prfOutput: Uint8Array, opts: UnlockOptions = {}): Promise<UnlockedKeys> {
  if (blob.kind !== "passkey") throw new InvalidPayload("vault kind");
  return unlockWith(blob, prfOutput, opts);
}

async function unlockWith(blob: VaultBlobV1, secret: VaultSecret, opts: UnlockOptions): Promise<UnlockedKeys> {
  if (blob.v !== 1) throw new UnknownSchemaVersion({ vault_version: (blob as { v?: number }).v ?? null });
  if (!(blob.kind in KDF_FOR_KIND) || !Object.prototype.hasOwnProperty.call(KDF_FOR_KIND, blob.kind)) throw new InvalidPayload("vault kind");
  if (typeof blob.pub?.ecdh !== "string" || typeof blob.pub?.ecdsa !== "string") throw new InvalidPayload("vault pub");
  if (blob.kdf?.name !== KDF_FOR_KIND[blob.kind]) throw new InvalidPayload("vault kind");
  const kek = await kekFor(blob.kdf, secret);
  const extractable = opts.extractable ?? false;
  let ecdhPrivate: CryptoKey;
  let ecdsaPrivate: CryptoKey;
  try {
    ecdhPrivate = await subtle.unwrapKey(
      "pkcs8", fromB64(blob.ecdh.ct), kek,
      { name: "AES-GCM", iv: fromB64(blob.ecdh.iv), additionalData: slotAad(blob.kind, "ecdh", blob.pub) },
      ECDH, extractable, ["deriveBits", "deriveKey"],
    );
    ecdsaPrivate = await subtle.unwrapKey(
      "pkcs8", fromB64(blob.ecdsa.ct), kek,
      { name: "AES-GCM", iv: fromB64(blob.ecdsa.iv), additionalData: slotAad(blob.kind, "ecdsa", blob.pub) },
      ECDSA, extractable, ["sign"],
    );
  } catch {
    throw new WrongPassphrase({ kind: blob.kind });
  }
  // Belt and braces: the unwrapped signing key must match the published public key.
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsaPrivate, SELF_CHECK);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importEcdsaPublic(blob.pub.ecdsa), sig, SELF_CHECK);
  if (!ok) throw new InvalidPayload("vault pub mismatch", { kind: blob.kind });
  return { ecdhPrivate, ecdsaPrivate, pub: blob.pub };
}

/** Key pairs (what `createVault` & co. take) from an EXTRACTABLE unlock, for re-wrapping the same keys under another door. */
export async function keyPairsOf(unlocked: UnlockedKeys): Promise<UserKeyPairs> {
  return {
    ecdh: { privateKey: unlocked.ecdhPrivate, publicKey: await importEcdhPublic(unlocked.pub.ecdh) },
    ecdsa: { privateKey: unlocked.ecdsaPrivate, publicKey: await importEcdsaPublic(unlocked.pub.ecdsa) },
  };
}

/**
 * The session copy of freshly generated (extractable) keys: the same private keys re-imported
 * as non-extractable handles, so a vault created with a passkey can open right away without a
 * second authenticator prompt. The pkcs8 bytes exist only inside this function.
 */
export async function sessionKeysFrom(keys: UserKeyPairs): Promise<UnlockedKeys> {
  const pub = await exportPublicKeys(keys);
  const ecdhBytes = new Uint8Array(await subtle.exportKey("pkcs8", keys.ecdh.privateKey));
  const ecdsaBytes = new Uint8Array(await subtle.exportKey("pkcs8", keys.ecdsa.privateKey));
  try {
    const ecdhPrivate = await subtle.importKey("pkcs8", ecdhBytes, ECDH, false, ["deriveBits", "deriveKey"]);
    const ecdsaPrivate = await subtle.importKey("pkcs8", ecdsaBytes, ECDSA, false, ["sign"]);
    return { ecdhPrivate, ecdsaPrivate, pub };
  } finally { ecdhBytes.fill(0); ecdsaBytes.fill(0); }
}

/** Crockford base32, 30 characters → 150 bits. Shown as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_CODE_CHARS = 30;

export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_CHARS);
  let out = "";
  for (let i = 0; i < RECOVERY_CODE_CHARS; i++) {
    out += CROCKFORD[(bytes[i] ?? 0) % 32];
    if (i % 5 === 4 && i < RECOVERY_CODE_CHARS - 1) out += "-";
  }
  return out;
}

/** Forgiving input: case, dashes, spaces, and the usual O/0 I/L/1 confusions are normalised away. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}
