import { argon2id } from "hash-wasm";
import { InvalidPayload } from "./errors.js";
import { copy, zero, type Bytes } from "./encoding.js";

const subtle = crypto.subtle;

/**
 * Pinned Argon2id cost for the vault passphrase (SPEC-ISSUES D).
 * m = 64 MiB, t = 3, p = 1. About 1 s on a 2020 mid-range phone, ~0.2 s on a laptop.
 * Stored in every vault blob, so it can be raised later without breaking old blobs.
 */
export const ARGON2ID_V1 = { name: "argon2id", m: 64 * 1024, t: 3, p: 1 } as const;

export interface Argon2Params {
  /** memory in KiB */
  readonly m: number;
  /** iterations */
  readonly t: number;
  /** parallelism */
  readonly p: number;
}

/**
 * Bounds for parameters read from a stored blob. Below the floor a tampered blob
 * would silently weaken the KDF; above the ceiling it would crash the tab.
 */
export const ARGON2_LIMITS = { mMin: 16 * 1024, mMax: 256 * 1024, tMin: 1, tMax: 10, pMin: 1, pMax: 4 } as const;

export function assertArgon2Params(p: Argon2Params): void {
  const ok = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
  if (!ok(p.m, ARGON2_LIMITS.mMin, ARGON2_LIMITS.mMax) || !ok(p.t, ARGON2_LIMITS.tMin, ARGON2_LIMITS.tMax) || !ok(p.p, ARGON2_LIMITS.pMin, ARGON2_LIMITS.pMax)) {
    throw new InvalidPayload("kdf params");
  }
}

export function assertSalt(salt: Uint8Array): void {
  if (salt.length < 16 || salt.length > 64) throw new InvalidPayload("kdf salt");
}

/** Raw Argon2id output with app-level bounds enforced. Callers that turn it into a key must `zero()` it afterwards; prefer `argon2idAesGcmKek`. */
export async function argon2idDerive(secret: string | Uint8Array, salt: Uint8Array, params: Argon2Params, length = 32): Promise<Bytes> {
  assertArgon2Params(params);
  assertSalt(salt);
  return argon2idRaw(secret, salt, params, length);
}

/** @internal The bare primitive, no bounds. Exported via ./testing.ts for known-answer tests only. */
export async function argon2idRaw(secret: string | Uint8Array, salt: Uint8Array, params: Argon2Params, length = 32): Promise<Bytes> {
  const out = await argon2id({
    password: secret,
    salt,
    iterations: params.t,
    parallelism: params.p,
    memorySize: params.m,
    hashLength: length,
    outputType: "binary",
  });
  return copy(out);
}

export async function hkdfDerive(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, lengthBytes: number): Promise<Bytes> {
  const key = await subtle.importKey("raw", copy(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: copy(salt), info: copy(info) }, key, lengthBytes * 8));
}

/** HKDF straight into a non-extractable AES key: the derived bytes never surface in JavaScript. */
export async function hkdfAesKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  algorithm: "AES-GCM" | "AES-KW",
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const key = await subtle.importKey("raw", copy(ikm), "HKDF", false, ["deriveKey"]);
  zero(ikm);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: copy(salt), info: copy(info) },
    key,
    { name: algorithm, length: 256 },
    false,
    usages,
  );
}

/** Imports raw KDF output as a non-extractable AES-GCM key-encryption key and zeroes the input. */
export async function importAesGcmKek(raw: Uint8Array): Promise<CryptoKey> {
  try {
    return await subtle.importKey("raw", copy(raw), { name: "AES-GCM" }, false, ["wrapKey", "unwrapKey", "encrypt", "decrypt"]);
  } finally {
    zero(raw);
  }
}

/** Argon2id straight into a KEK. The derived bytes live only until import. */
export async function argon2idAesGcmKek(secret: string, salt: Uint8Array, params: Argon2Params): Promise<CryptoKey> {
  return importAesGcmKek(await argon2idDerive(secret, salt, params));
}
