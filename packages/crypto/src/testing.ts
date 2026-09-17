/**
 * Test-only entry point. Not exported from the package index. Importing this
 * from application code is a bug: `sealWithNonce` lets a caller repeat a nonce.
 */
export { sealWithNonce } from "./seal.js";
export { argon2idRaw } from "./kdf.js";
