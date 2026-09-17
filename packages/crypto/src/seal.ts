import { AuthTagMismatch, InvalidPayload, UnknownSchemaVersion } from "./errors.js";
import { copy, randomBytes, type Bytes } from "./encoding.js";
import { aadBytes, assertIdentity, assertSealableIdentity, BUCKET_BYTES, SUPPORTED_SCHEMA_VERSIONS, type RecordIdentity } from "./identity.js";
import { pad, unpad } from "./padding.js";

const subtle = crypto.subtle;
export const NONCE_BYTES = 12;

export interface Sealed {
  readonly nonce: Bytes;
  readonly ciphertext: Bytes;
}

/**
 * A fresh drawer data key. Non-extractable by default. `createDrawerKey` in
 * drawerKey.ts is the normal entry point: it produces the creator's own wrap and
 * hands back a non-extractable handle.
 */
export async function generateDrawerKey(opts: { extractable?: boolean } = {}): Promise<CryptoKey> {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, opts.extractable ?? false, ["encrypt", "decrypt"]);
}

/** Every production seal draws a fresh random nonce. There is no way to supply one. */
export async function seal(key: CryptoKey, identity: RecordIdentity, plaintext: Uint8Array): Promise<Sealed> {
  return sealWithNonce(key, identity, plaintext, randomBytes(NONCE_BYTES));
}

/** @internal Exported through ./testing.ts only, for deterministic tests. A repeated nonce under one key breaks AES-GCM. */
export async function sealWithNonce(key: CryptoKey, identity: RecordIdentity, plaintext: Uint8Array, nonce: Uint8Array): Promise<Sealed> {
  assertSealableIdentity(identity);
  if (nonce.length !== NONCE_BYTES) throw new InvalidPayload("nonce");
  const padded = pad(plaintext, BUCKET_BYTES[identity.record_type]);
  const iv = copy(nonce);
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadBytes(identity), tagLength: 128 }, key, padded),
  );
  return { nonce: iv, ciphertext };
}

export async function open(key: CryptoKey, identity: RecordIdentity, sealed: Sealed): Promise<Bytes> {
  assertIdentity(identity);
  const ctx = identityContext(identity);
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(identity.schema_version)) throw new UnknownSchemaVersion(ctx);
  if (sealed.nonce.length !== NONCE_BYTES) throw new AuthTagMismatch(ctx);
  let padded: ArrayBuffer;
  try {
    padded = await subtle.decrypt(
      { name: "AES-GCM", iv: copy(sealed.nonce), additionalData: aadBytes(identity), tagLength: 128 },
      key,
      copy(sealed.ciphertext),
    );
  } catch {
    throw new AuthTagMismatch(ctx);
  }
  return unpad(new Uint8Array(padded));
}

/** Key rotation for one row: open under the old key generation, seal under the new one. Plaintext stays in memory only. */
export async function reseal(
  oldKey: CryptoKey,
  newKey: CryptoKey,
  identity: RecordIdentity,
  sealed: Sealed,
  newKeyVersion: number,
): Promise<{ identity: RecordIdentity; sealed: Sealed }> {
  if (!Number.isInteger(newKeyVersion) || newKeyVersion <= identity.key_version) throw new InvalidPayload("key_version");
  const plaintext = await open(oldKey, identity, sealed);
  const next: RecordIdentity = { ...identity, key_version: newKeyVersion, schema_version: identity.schema_version };
  return { identity: next, sealed: await seal(newKey, next, plaintext) };
}

export function identityContext(id: RecordIdentity): Record<string, string | number | null> {
  return {
    record_type: id.record_type,
    record_id: id.record_id,
    drawer_id: id.drawer_id,
    line_id: id.line_id,
    author_id: id.author_id,
    key_version: id.key_version,
    schema_version: id.schema_version,
  };
}
