import { InvalidPayload } from "./errors.js";
import { lengthPrefixed, utf8, type Bytes } from "./encoding.js";

/** Format version of every payload this package writes. Bump only with a migration path. */
export const SCHEMA_VERSION = 1 as const;
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

export const RECORD_TYPES = ["entry", "document", "photo"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * The identity a ciphertext is bound to. Every field is a plaintext column on the
 * row. It goes into AES-GCM additional authenticated data, so a ciphertext copied
 * to another row, line, drawer, key generation, or format version fails to open.
 * CLAUDE.md rule 3, plus `line_id` (SPEC-ISSUES B1).
 */
export interface RecordIdentity {
  readonly record_type: RecordType;
  readonly record_id: string;
  readonly drawer_id: string;
  /** Required for entries, must be null for documents and photos. */
  readonly line_id: string | null;
  /** Server-stamped from the session on every row. Binding it means a row's author column cannot be rewritten (SPEC-ISSUES review, entry.ts). */
  readonly author_id: string;
  readonly key_version: number;
  readonly schema_version: number;
}

const AAD_DOMAIN = "petty/record-aad/v1";

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}
function isNonEmptyString(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 256;
}

/** New ciphertext is always written in this build's format. Only `open` accepts older supported versions. */
export function assertSealableIdentity(id: RecordIdentity): void {
  assertIdentity(id);
  if (id.schema_version !== SCHEMA_VERSION) throw new InvalidPayload("identity.schema_version");
}

export function assertIdentity(id: RecordIdentity): void {
  if (!RECORD_TYPES.includes(id.record_type)) throw new InvalidPayload("identity.record_type");
  if (!isNonEmptyString(id.record_id)) throw new InvalidPayload("identity.record_id");
  if (!isNonEmptyString(id.drawer_id)) throw new InvalidPayload("identity.drawer_id");
  if (!isNonEmptyString(id.author_id)) throw new InvalidPayload("identity.author_id");
  if (!isPositiveInt(id.key_version)) throw new InvalidPayload("identity.key_version");
  if (!isPositiveInt(id.schema_version)) throw new InvalidPayload("identity.schema_version");
  if (id.record_type === "entry") {
    if (!isNonEmptyString(id.line_id)) throw new InvalidPayload("identity.line_id");
  } else if (id.line_id !== null) {
    throw new InvalidPayload("identity.line_id");
  }
}

/** Canonical AAD bytes. Length-prefixed so no field can bleed into its neighbour. */
export function aadBytes(id: RecordIdentity): Bytes {
  assertIdentity(id);
  return lengthPrefixed([
    utf8(AAD_DOMAIN),
    utf8(id.record_type),
    utf8(id.record_id),
    utf8(id.drawer_id),
    utf8(id.line_id ?? ""),
    utf8(id.author_id),
    utf8(String(id.key_version)),
    utf8(String(id.schema_version)),
  ]);
}

/** Plaintext is padded to a multiple of this many bytes, so size reveals nothing about amounts. */
export const BUCKET_BYTES: Readonly<Record<RecordType, number>> = {
  entry: 256,
  document: 16 * 1024,
  photo: 16 * 1024,
};
