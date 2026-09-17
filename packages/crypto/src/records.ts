import { InvalidPayload } from "./errors.js";
import { canonicalJson, fromUtf8, utf8, type Bytes } from "./encoding.js";
import type { RecordIdentity } from "./identity.js";
import { open, seal, type Sealed } from "./seal.js";

/** Drawer document: any JSON value. Its shape is owned by @petty/ledger. Sealed as canonical JSON. */
export async function sealDocument(drawerKey: CryptoKey, identity: RecordIdentity, document: unknown): Promise<Sealed> {
  if (identity.record_type !== "document") throw new InvalidPayload("identity.record_type");
  return seal(drawerKey, identity, utf8(canonicalJson(document)));
}

export async function openDocument(drawerKey: CryptoKey, identity: RecordIdentity, sealed: Sealed): Promise<unknown> {
  if (identity.record_type !== "document") throw new InvalidPayload("identity.record_type");
  const bytes = await open(drawerKey, identity, sealed);
  try {
    return JSON.parse(fromUtf8(bytes));
  } catch {
    throw new InvalidPayload("document json", { record_id: identity.record_id });
  }
}

/** Drawer photo: raw JPEG bytes (already downscaled and EXIF-free — the caller's job). */
export async function sealPhoto(drawerKey: CryptoKey, identity: RecordIdentity, jpeg: Uint8Array): Promise<Sealed> {
  if (identity.record_type !== "photo") throw new InvalidPayload("identity.record_type");
  return seal(drawerKey, identity, jpeg);
}

export async function openPhoto(drawerKey: CryptoKey, identity: RecordIdentity, sealed: Sealed): Promise<Bytes> {
  if (identity.record_type !== "photo") throw new InvalidPayload("identity.record_type");
  return open(drawerKey, identity, sealed);
}
