import { InvalidPayload } from "./errors.js";
import { concat, fromB64, sha256, toB64, toHex, utf8 } from "./encoding.js";

const subtle = crypto.subtle;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * Two keypairs per user (SPEC-ISSUES A3): ECDH for wrapping drawer keys,
 * ECDSA for signing entries. Generated extractable, because WebCrypto can only
 * wrap an extractable key. The caller must wrap both private keys into the vault
 * and the recovery blob immediately and then drop this object. Unlocking later
 * yields non-extractable keys.
 */
export interface UserKeyPairs {
  readonly ecdh: CryptoKeyPair;
  readonly ecdsa: CryptoKeyPair;
}

export async function generateUserKeys(): Promise<UserKeyPairs> {
  const ecdh = await subtle.generateKey(ECDH, true, ["deriveBits", "deriveKey"]);
  const ecdsa = await subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  return { ecdh, ecdsa };
}

/** Public halves, base64 SPKI. This is what the server publishes and what pinning compares. */
export interface PublicKeys {
  readonly ecdh: string;
  readonly ecdsa: string;
}

export async function exportPublicKeys(keys: { ecdh: CryptoKeyPair | CryptoKey; ecdsa: CryptoKeyPair | CryptoKey }): Promise<PublicKeys> {
  const pub = (k: CryptoKeyPair | CryptoKey): CryptoKey => ("publicKey" in k ? k.publicKey : k);
  return {
    ecdh: toB64(new Uint8Array(await subtle.exportKey("spki", pub(keys.ecdh)))),
    ecdsa: toB64(new Uint8Array(await subtle.exportKey("spki", pub(keys.ecdsa)))),
  };
}

export async function importEcdhPublic(spkiB64: string): Promise<CryptoKey> {
  try {
    return await subtle.importKey("spki", fromB64(spkiB64), ECDH, true, []);
  } catch {
    throw new InvalidPayload("ecdh public key");
  }
}

export async function importEcdsaPublic(spkiB64: string): Promise<CryptoKey> {
  try {
    return await subtle.importKey("spki", fromB64(spkiB64), ECDSA, true, ["verify"]);
  } catch {
    throw new InvalidPayload("ecdsa public key");
  }
}

/**
 * Safety number: 30 decimal digits in six groups of five, derived from both public
 * keys. Two people compare it out of band. ~99.6 bits.
 */
export async function safetyNumber(pub: PublicKeys): Promise<string> {
  const h = await sha256(concat(utf8("petty/safety-number/v1"), fromB64(pub.ecdh), fromB64(pub.ecdsa)));
  let n = 0n;
  for (const b of h) n = (n << 8n) | BigInt(b);
  const digits = (n % 10n ** 30n).toString().padStart(30, "0");
  return (digits.match(/.{5}/g) ?? []).join(" ");
}

/** Stable id for one signing key: first 16 bytes of SHA-256(SPKI), hex. Stored on every entry as `sig_key_id`. */
export async function signingKeyId(ecdsaSpkiB64: string): Promise<string> {
  const h = await sha256(concat(utf8("petty/sig-key-id/v1"), fromB64(ecdsaSpkiB64)));
  return toHex(h.subarray(0, 16));
}
