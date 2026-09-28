/**
 * @petty/crypto — envelope encryption for Petty.
 *
 * Primitives: WebCrypto only (ECDH P-256, ECDSA P-256, HKDF-SHA256, AES-KW,
 * AES-256-GCM) plus Argon2id from hash-wasm. Nothing is hand-assembled.
 *
 * Invariants this package enforces:
 *  - every record ciphertext is bound to its row identity via AAD (identity.ts)
 *  - plaintext is padded to fixed buckets before encryption (padding.ts)
 *  - unlocked keys are non-extractable unless the caller asks for a re-wrap
 *  - a wrap is only unwrapped with the recipient's PINNED sender key (drawerKey.ts)
 *  - the vault blob's public keys are authenticated by the wraps' AAD (vault.ts)
 *  - errors carry codes and ids, never content (errors.ts)
 *  - production code cannot choose a nonce (seal.ts; testing.ts is test-only)
 */
export * from "./errors.js";
export { canonicalJson, fromB64, toB64, fromHex, toHex, utf8, fromUtf8, randomBytes, sha256, bytesEqual, zero, type Bytes } from "./encoding.js";
export * from "./identity.js";
export { pad, unpad } from "./padding.js";
export { ARGON2ID_V1, ARGON2_LIMITS, assertArgon2Params, assertSalt, argon2idDerive, argon2idAesGcmKek, hkdfDerive, hkdfAesKey, importAesGcmKek, type Argon2Params } from "./kdf.js";
export { NONCE_BYTES, generateDrawerKey, seal, open, reseal, identityContext, type Sealed } from "./seal.js";
export * from "./keys.js";
export * from "./vault.js";
export * from "./drawerKey.js";
export * from "./entry.js";
export * from "./records.js";
export * from "./archive.js";
export * from "./custody.js";
export * from "./pat.js";
export * from "./delegation.js";
export * from "./device.js";
