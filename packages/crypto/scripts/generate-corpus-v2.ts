/**
 * Generates the ciphertext compatibility corpus for drawer documents of format 2 (PETTY-422): a document
 * with its counter inside, sealed under `schema_version` 2. Entries, photos, vaults and archives did not
 * change format; corpus/v1 stays the record for them.
 *
 * RUN ONCE. The output is committed and never regenerated: every future build must open these exact bytes
 * (test/corpus.test.ts). The script refuses to overwrite existing files.
 *
 * The drawer keys are test keys and exist only here.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DOCUMENT_SCHEMA_VERSION, generateDrawerKey, reseal, sealDocument, toB64, toHex, type RecordIdentity, type Sealed } from "../src/index.js";

const OUT = fileURLToPath(new URL("../corpus/v2/", import.meta.url));
const DRAWER = "d2000000-0000-4000-8000-000000000002";
const LINE = "l2000000-0000-4000-8000-000000000002";

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
const sealedJson = (s: Sealed) => ({ nonce: toB64(s.nonce), ciphertext: toB64(s.ciphertext) });

async function main() {
  await mkdir(OUT, { recursive: true });
  if (await exists(OUT + "drawer.json")) throw new Error("refusing to overwrite corpus file drawer.json");

  const k1 = await generateDrawerKey({ extractable: true });
  const k2 = await generateDrawerKey({ extractable: true });
  const rawKey = async (k: CryptoKey) => toHex(new Uint8Array(await crypto.subtle.exportKey("raw", k)));

  const document = {
    v: 1, rev: 7, name: "Kitchen drawer", has_photo: false, tags: ["Kitchen", "shelf"], icon: "home", color: "teal",
    lines: [
      { id: LINE, kind: "money", name: "PLN kitchen", currency: "PLN", exponent: 2, tags: ["cash"] },
      { id: "l2", kind: "countable", name: "Glass balls", unit: "balls", counted: false },
      { id: "l3", kind: "single", name: "Passport", text: "zażółć gęślą jaźń — expires 2031" },
    ],
    verifications: [{ id: "v1", author_id: "user-alice", logged_at: "2026-11-10T12:30:00.000Z", comment: "counted with Bob", lines: [{ line_id: LINE, kind: "money", balance: 10000, present: null, head_seq: 4 }, { line_id: "l3", kind: "single", balance: null, present: true, head_seq: null }] }],
  };
  const identity: RecordIdentity = { record_type: "document", record_id: DRAWER, drawer_id: DRAWER, line_id: null, author_id: "user-alice", key_version: 1, schema_version: DOCUMENT_SCHEMA_VERSION };
  const first = await sealDocument(k1, identity, document);
  // A key rotation re-seals the same document: the format and the counter stay.
  const rotated = await reseal(k1, k2, identity, first, 2);

  await writeFile(OUT + "drawer.json", JSON.stringify({
    format: "petty-corpus-drawer", v: 2, drawer_id: DRAWER,
    keys: { "1": await rawKey(k1), "2": await rawKey(k2) },
    records: [
      { identity, sealed: sealedJson(first), plaintext: document },
      { identity: rotated.identity, sealed: sealedJson(rotated.sealed), plaintext: document },
    ],
  }, null, 2));
  process.stdout.write(`corpus v2 written to ${OUT}\n`);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
