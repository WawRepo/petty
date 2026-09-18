import { canonicalJson, concat, fromB64, toB64, utf8 } from "./encoding.js";
import { InvalidPayload, SignatureInvalid } from "./errors.js";
import { importEcdsaPublic, signingKeyId } from "./keys.js";

const subtle = crypto.subtle;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
/** Domain separation: a delegation can never be mistaken for an entry signature or a custody proof. */
const CONTEXT = utf8("petty/signing-delegation/v1");

/**
 * A signing delegation (PETTY-184, review NR-4). A writing access token gets its OWN ECDSA key,
 * never the account key. The account key signs this statement: "entries signed by this token key
 * are mine, until `expires_at`". Readers check the statement against the author's account key, so
 * the server cannot invent a token key for someone. Revocation is the server saying when it
 * stopped accepting the token; readers reject entries it received after that.
 */
export interface SigningDelegationV1 {
  readonly v: 1;
  readonly user_id: string;
  /** The account key that signs this delegation. */
  readonly account_sig_key_id: string;
  /** base64 SPKI of the token's ECDSA P-256 public key. */
  readonly token_ecdsa_pub: string;
  /** signingKeyId(token_ecdsa_pub): the sig_key_id on every entry the token signs. */
  readonly token_sig_key_id: string;
  readonly created_at: string;
  /** null = until revoked */
  readonly expires_at: string | null;
}

export interface SignedDelegationV1 extends SigningDelegationV1 {
  /** base64 ECDSA signature by the account key over the canonical payload. */
  readonly sig: string;
}

const FIELDS = ["v", "user_id", "account_sig_key_id", "token_ecdsa_pub", "token_sig_key_id", "created_at", "expires_at"] as const;

function payloadOf(d: SigningDelegationV1): SigningDelegationV1 {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = d[k];
  return out as unknown as SigningDelegationV1;
}

const signedBytes = (d: SigningDelegationV1) => concat(CONTEXT, utf8(canonicalJson(payloadOf(d))));

function assertShape(d: unknown): asserts d is SignedDelegationV1 {
  if (typeof d !== "object" || d === null) throw new InvalidPayload("delegation");
  const r = d as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== "sig" && !(FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new InvalidPayload("delegation.fields");
  if (r["v"] !== 1) throw new InvalidPayload("delegation.v");
  for (const k of ["user_id", "account_sig_key_id", "token_ecdsa_pub", "token_sig_key_id", "created_at", "sig"]) if (typeof r[k] !== "string" || !r[k]) throw new InvalidPayload(`delegation.${k}`);
  if (r["expires_at"] !== null && typeof r["expires_at"] !== "string") throw new InvalidPayload("delegation.expires_at");
}

export async function signDelegation(accountEcdsaPrivate: CryptoKey, d: Omit<SigningDelegationV1, "v" | "token_sig_key_id">): Promise<SignedDelegationV1> {
  const payload: SigningDelegationV1 = { v: 1, ...d, token_sig_key_id: await signingKeyId(d.token_ecdsa_pub) };
  const sig = await subtle.sign(ECDSA_SIGN, accountEcdsaPrivate, signedBytes(payload));
  return { ...payloadOf(payload), sig: toB64(new Uint8Array(sig)) };
}

/**
 * Throws SignatureInvalid unless the delegation is for this user, names this account key, its
 * token key id matches its token key, and the account key signed it.
 */
export async function verifyDelegation(d: unknown, account: { user_id: string; sig_key_id: string; ecdsa_pub: string }): Promise<SignedDelegationV1> {
  assertShape(d);
  const ctx = { author_id: d.user_id, sig_key_id: d.token_sig_key_id };
  if (d.user_id !== account.user_id || d.account_sig_key_id !== account.sig_key_id) throw new SignatureInvalid(ctx);
  if (d.token_sig_key_id !== (await signingKeyId(d.token_ecdsa_pub))) throw new SignatureInvalid(ctx);
  let ok = false;
  try {
    ok = await subtle.verify(ECDSA_SIGN, await importEcdsaPublic(account.ecdsa_pub), fromB64(d.sig), signedBytes(d));
  } catch {
    ok = false;
  }
  if (!ok) throw new SignatureInvalid(ctx);
  return d;
}

/** Was an entry the server received at `receivedAt` inside the delegation's life? */
export function delegationCovers(d: SigningDelegationV1, receivedAt: string, revokedAt: string | null): boolean {
  const t = Date.parse(receivedAt);
  if (Number.isNaN(t)) return false;
  if (d.expires_at && t > Date.parse(d.expires_at)) return false;
  if (revokedAt && t > Date.parse(revokedAt)) return false;
  return true;
}
