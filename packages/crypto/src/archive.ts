import { InvalidPayload, UnknownSchemaVersion, WrongPassphrase } from "./errors.js";
import { canonicalJson, copy, fromB64, fromUtf8, randomBytes, toB64, utf8 } from "./encoding.js";
import { ARGON2ID_V1, argon2idAesGcmKek } from "./kdf.js";
import { pad, unpad } from "./padding.js";

const subtle = crypto.subtle;
const ARCHIVE_AAD = utf8("petty/export-archive/v1");
const ARCHIVE_BUCKET = 16 * 1024;
export const EXPORT_PASSWORD_MIN_LENGTH = 12;

/** User-controlled encrypted export. Independent of the vault: its own password, its own Argon2id salt. */
export interface ExportArchiveV1 {
  readonly v: 1;
  readonly kdf: { readonly name: "argon2id"; readonly m: number; readonly t: number; readonly p: number; readonly salt: string };
  readonly nonce: string;
  readonly ciphertext: string;
}

export async function sealArchive(password: string, payload: unknown): Promise<ExportArchiveV1> {
  const normalized = password.normalize("NFKC");
  if (normalized.length < EXPORT_PASSWORD_MIN_LENGTH) throw new InvalidPayload("export password length");
  const salt = randomBytes(16);
  const kek = await argon2idAesGcmKek(normalized, salt, ARGON2ID_V1);
  const nonce = randomBytes(12);
  const padded = pad(utf8(canonicalJson(payload)), ARCHIVE_BUCKET);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: ARCHIVE_AAD }, kek, padded));
  return { v: 1, kdf: { ...ARGON2ID_V1, salt: toB64(salt) }, nonce: toB64(nonce), ciphertext: toB64(ct) };
}

export async function openArchive(password: string, archive: ExportArchiveV1): Promise<unknown> {
  if (archive.v !== 1) throw new UnknownSchemaVersion({ archive_version: (archive as { v?: number }).v ?? null });
  if (archive.kdf.name !== "argon2id") throw new InvalidPayload("kdf name");
  const kek = await argon2idAesGcmKek(password.normalize("NFKC"), fromB64(archive.kdf.salt), archive.kdf);
  let padded: ArrayBuffer;
  try {
    padded = await subtle.decrypt({ name: "AES-GCM", iv: copy(fromB64(archive.nonce)), additionalData: ARCHIVE_AAD }, kek, copy(fromB64(archive.ciphertext)));
  } catch {
    throw new WrongPassphrase({ kind: "export" });
  }
  try {
    return JSON.parse(fromUtf8(unpad(new Uint8Array(padded))));
  } catch {
    throw new InvalidPayload("archive json");
  }
}
