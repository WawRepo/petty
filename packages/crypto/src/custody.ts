import { concat, fromB64, toB64, utf8 } from "./encoding.js";
import { importEcdsaPublic } from "./keys.js";

const subtle = crypto.subtle;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
/** Domain separation: a custody proof can never be mistaken for an entry signature. */
const CONTEXT = utf8("petty/custody-proof/v1");

/**
 * Proof of key possession for destructive custody operations (security review
 * SR-2): replacing the vault blobs, deleting the account. The server issues a
 * random challenge; only an UNLOCKED vault can sign it, so a login password
 * alone (which email can reset) is no longer enough to destroy someone's keys.
 */
export async function signCustodyChallenge(ecdsaPrivate: CryptoKey, challengeB64: string): Promise<string> {
  const sig = await subtle.sign(ECDSA_SIGN, ecdsaPrivate, concat(CONTEXT, fromB64(challengeB64)));
  return toB64(new Uint8Array(sig));
}

export async function verifyCustodyProof(ecdsaSpkiB64: string, challengeB64: string, signatureB64: string): Promise<boolean> {
  try {
    const key = await importEcdsaPublic(ecdsaSpkiB64);
    return await subtle.verify(ECDSA_SIGN, key, fromB64(signatureB64), concat(CONTEXT, fromB64(challengeB64)));
  } catch {
    return false;
  }
}
