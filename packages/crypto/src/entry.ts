import { InvalidPayload, SignatureInvalid } from "./errors.js";
import { canonicalJson, fromB64, fromUtf8, sha256, toB64, toHex, utf8, type Bytes } from "./encoding.js";
import type { RecordIdentity } from "./identity.js";
import { open, seal, type Sealed } from "./seal.js";

const subtle = crypto.subtle;

export const ENTRY_OPS = ["add", "withdraw", "adjust", "reverse"] as const;
export type EntryOp = (typeof ENTRY_OPS)[number];

/**
 * Entry payload, format v1. Sealed as canonical JSON inside the ciphertext.
 * `amount` is an integer in minor units. For `adjust` it is the absolute counted
 * value; for `add`/`withdraw`/`reverse` it is the signed change. Interpretation
 * (the fold) lives in @petty/ledger; this package only guarantees shape,
 * signature and hash.
 */
export interface EntryPayloadV1 {
  readonly v: 1;
  readonly id: string;
  readonly drawer_id: string;
  readonly line_id: string;
  readonly op: EntryOp;
  readonly amount: number;
  readonly exponent: number;
  readonly comment: string;
  /** Client clock, ISO 8601. The server's `received_at` is the ordering clock. */
  readonly logged_at: string;
  /** For `reverse`: the id of the entry it cancels. */
  readonly reverses: string | null;
  /** Hex SHA-256 (see hashEntry) of the newest entry the author had seen on this line, or null for the first. */
  readonly prev_hash: string | null;
  /** For `adjust`: display-only difference against the balance the author saw. Never folded. */
  readonly delta_hint: number | null;
  readonly author_id: string;
  readonly sig_key_id: string;
}

export interface SignedEntryV1 extends EntryPayloadV1 {
  /** base64 ECDSA P-256/SHA-256 over canonicalJson of the payload without `sig`. */
  readonly sig: string;
}

const FIELDS_V1 = new Set(["v", "id", "drawer_id", "line_id", "op", "amount", "exponent", "comment", "logged_at", "reverses", "prev_hash", "delta_hint", "author_id", "sig_key_id", "sig"]);
/** Bytes, not UTF-16 units: a comment above one bucket makes the ciphertext grow in 256 B steps, which is an accepted, bounded size leak. */
export const MAX_COMMENT_BYTES = 2000;
const HEX64 = /^[0-9a-f]{64}$/;

function str(x: unknown, max = 256): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= max;
}

export function assertEntryShape(x: unknown): asserts x is SignedEntryV1 {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new InvalidPayload("entry");
  const e = x as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!FIELDS_V1.has(k)) throw new InvalidPayload("entry field");
  if (e["v"] !== 1) throw new InvalidPayload("entry.v");
  for (const k of ["id", "drawer_id", "line_id", "author_id", "sig_key_id"]) if (!str(e[k])) throw new InvalidPayload(`entry.${k}`);
  if (!ENTRY_OPS.includes(e["op"] as EntryOp)) throw new InvalidPayload("entry.op");
  if (!Number.isSafeInteger(e["amount"])) throw new InvalidPayload("entry.amount");
  if (!Number.isInteger(e["exponent"]) || (e["exponent"] as number) < 0 || (e["exponent"] as number) > 8) throw new InvalidPayload("entry.exponent");
  if (typeof e["comment"] !== "string" || utf8(e["comment"]).length > MAX_COMMENT_BYTES) throw new InvalidPayload("entry.comment");
  if (!str(e["logged_at"], 64)) throw new InvalidPayload("entry.logged_at");
  if (e["reverses"] !== null && !str(e["reverses"])) throw new InvalidPayload("entry.reverses");
  if (e["prev_hash"] !== null && !(typeof e["prev_hash"] === "string" && HEX64.test(e["prev_hash"]))) throw new InvalidPayload("entry.prev_hash");
  if (e["delta_hint"] !== null && !Number.isSafeInteger(e["delta_hint"])) throw new InvalidPayload("entry.delta_hint");
  if (!str(e["sig"], 128)) throw new InvalidPayload("entry.sig");
  if ((e["op"] === "reverse") !== (e["reverses"] !== null)) throw new InvalidPayload("entry.reverses");
  if (e["op"] !== "adjust" && e["delta_hint"] !== null) throw new InvalidPayload("entry.delta_hint");
}

/** Canonical bytes of the payload without `sig`. Both the signature and the chain hash are over these. */
function signedBytes(payload: EntryPayloadV1): Bytes {
  const { sig: _drop, ...rest } = payload as SignedEntryV1;
  void _drop;
  return utf8(canonicalJson(rest));
}

export async function signEntry(payload: EntryPayloadV1, ecdsaPrivate: CryptoKey): Promise<SignedEntryV1> {
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsaPrivate, signedBytes(payload)));
  const signed: SignedEntryV1 = { ...payload, sig: toB64(sig) };
  assertEntryShape(signed);
  return signed;
}

/** Who the caller believes wrote the entry, and the pinned public key for that (author, key id) pair. */
export interface Author {
  readonly author_id: string;
  readonly sig_key_id: string;
  readonly ecdsaPublic: CryptoKey;
}

/**
 * Throws SignatureInvalid unless the entry names exactly this author and key id
 * AND `sig` verifies under that key. Checking the ids here stops a member from
 * signing "author_id: alice" with their own key.
 */
export async function verifyEntry(entry: SignedEntryV1, author: Author): Promise<void> {
  assertEntryShape(entry);
  const ctx = { entry_id: entry.id, author_id: entry.author_id, sig_key_id: entry.sig_key_id };
  if (entry.author_id !== author.author_id || entry.sig_key_id !== author.sig_key_id) throw new SignatureInvalid(ctx);
  let ok = false;
  try {
    ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, author.ecdsaPublic, fromB64(entry.sig), signedBytes(entry));
  } catch {
    ok = false;
  }
  if (!ok) throw new SignatureInvalid(ctx);
}

/**
 * Hex SHA-256 of the signed bytes (payload without `sig`). This is what the next
 * entry's `prev_hash` points at. The signature is excluded because ECDSA
 * signatures are malleable (high-s twin), which would give one entry two hashes.
 */
export async function hashEntry(entry: EntryPayloadV1): Promise<string> {
  return toHex(await sha256(signedBytes(entry)));
}

function assertEntryMatchesIdentity(entry: EntryPayloadV1, identity: RecordIdentity): void {
  if (identity.record_type !== "entry") throw new InvalidPayload("identity.record_type");
  if (identity.record_id !== entry.id || identity.drawer_id !== entry.drawer_id || identity.line_id !== entry.line_id || identity.author_id !== entry.author_id) {
    throw new InvalidPayload("entry identity", { record_id: identity.record_id, drawer_id: identity.drawer_id });
  }
}

export async function sealEntry(drawerKey: CryptoKey, identity: RecordIdentity, entry: SignedEntryV1): Promise<Sealed> {
  assertEntryShape(entry);
  assertEntryMatchesIdentity(entry, identity);
  return seal(drawerKey, identity, utf8(canonicalJson(entry)));
}

/**
 * Open, parse, shape-check, confirm the payload's ids equal the row's plaintext
 * identity, and verify the author's signature. This is the only open the app
 * should use for display and folding.
 */
export async function openEntry(drawerKey: CryptoKey, identity: RecordIdentity, sealed: Sealed, author: Author): Promise<SignedEntryV1> {
  const entry = await openEntryUnverified(drawerKey, identity, sealed);
  await verifyEntry(entry, author);
  return entry;
}

/** Same without the signature check. For import, migration and diagnostics only — never for display or folding. */
export async function openEntryUnverified(drawerKey: CryptoKey, identity: RecordIdentity, sealed: Sealed): Promise<SignedEntryV1> {
  const bytes = await open(drawerKey, identity, sealed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new InvalidPayload("entry json", { record_id: identity.record_id });
  }
  assertEntryShape(parsed);
  assertEntryMatchesIdentity(parsed, identity);
  return parsed;
}
