/**
 * Generates the ciphertext compatibility corpus for format v1.
 *
 * RUN ONCE. The output is committed and never regenerated: every future build
 * must open these exact bytes (test/corpus.test.ts). A new format version gets a
 * new directory (corpus/v2), never a rewrite of this one. The script refuses to
 * overwrite existing files.
 *
 * Private keys are written as JWK. They are test keys and exist only here.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createRecoveryVault, createVault, exportPublicKeys, generateDrawerKey, generateRecoveryCode, generateUserKeys,
  hashEntry, safetyNumber, sealArchive, sealDocument, sealEntry, sealPhoto, signEntry, signingKeyId, toB64, toHex,
  wrapDrawerKey, utf8, reseal,
  type EntryPayloadV1, type RecordIdentity, type Sealed,
} from "../src/index.js";

const OUT = fileURLToPath(new URL("../corpus/v1/", import.meta.url));
const DRAWER = "d1000000-0000-4000-8000-000000000001";
const LINE = "l1000000-0000-4000-8000-000000000001";
const subtle = crypto.subtle;

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
function sealedJson(s: Sealed) {
  return { nonce: toB64(s.nonce), ciphertext: toB64(s.ciphertext) };
}

async function user(name: string, passphrase: string) {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const recovery_code = generateRecoveryCode();
  return {
    id: `user-${name}`,
    name,
    passphrase,
    recovery_code,
    jwk: {
      ecdh_private: await subtle.exportKey("jwk", keys.ecdh.privateKey),
      ecdsa_private: await subtle.exportKey("jwk", keys.ecdsa.privateKey),
    },
    pub,
    safety_number: await safetyNumber(pub),
    sig_key_id: await signingKeyId(pub.ecdsa),
    vault: await createVault(passphrase, keys),
    recovery_vault: await createRecoveryVault(recovery_code, keys),
    keys,
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const f of ["users.json", "drawer.json", "archive.json"]) {
    if (await exists(OUT + f)) throw new Error(`refusing to overwrite corpus file ${f}`);
  }

  const alice = await user("alice", "alice vault passphrase 2026");
  const bob = await user("bob", "bob vault passphrase 2026");

  const k1 = await generateDrawerKey({ extractable: true });
  const k2 = await generateDrawerKey({ extractable: true });
  const rawKey = async (k: CryptoKey) => toHex(new Uint8Array(await subtle.exportKey("raw", k)));

  const sender = { ecdhPrivate: alice.keys.ecdh.privateKey, ecdhPublicB64: alice.pub.ecdh };
  const wraps = [
    { recipient: alice.id, ...(await wrapDrawerKey(k1, sender, alice.pub.ecdh, DRAWER, 1)) },
    { recipient: bob.id, ...(await wrapDrawerKey(k1, sender, bob.pub.ecdh, DRAWER, 1)) },
    { recipient: alice.id, ...(await wrapDrawerKey(k2, sender, alice.pub.ecdh, DRAWER, 2)) },
    { recipient: bob.id, ...(await wrapDrawerKey(k2, sender, bob.pub.ecdh, DRAWER, 2)) },
  ];

  const base = (over: Partial<EntryPayloadV1>): EntryPayloadV1 => ({
    v: 1, id: "", drawer_id: DRAWER, line_id: LINE, op: "add", amount: 0, exponent: 2, comment: "",
    logged_at: "2026-08-28T12:00:00.000Z", reverses: null, prev_hash: null, delta_hint: null,
    author_id: alice.id, sig_key_id: alice.sig_key_id, ...over,
  });
  const e1 = await signEntry(base({ id: "e1", amount: 10000, comment: "starting balance" }), alice.keys.ecdsa.privateKey);
  const e2 = await signEntry(base({ id: "e2", op: "withdraw", amount: -2550, comment: "zażółć gęślą jaźń — pizza 🍕", prev_hash: await hashEntry(e1), author_id: bob.id, sig_key_id: bob.sig_key_id }), bob.keys.ecdsa.privateKey);
  const e3 = await signEntry(base({ id: "e3", op: "reverse", amount: 2550, reverses: "e2", prev_hash: await hashEntry(e2) }), alice.keys.ecdsa.privateKey);
  const e4 = await signEntry(base({ id: "e4", op: "adjust", amount: 9900, delta_hint: -100, prev_hash: await hashEntry(e3), exponent: 0 }), alice.keys.ecdsa.privateKey);

  const ident = (record_type: RecordIdentity["record_type"], record_id: string, key_version: number, author_id: string): RecordIdentity => ({
    record_type, record_id, drawer_id: DRAWER, line_id: record_type === "entry" ? LINE : null, author_id, key_version, schema_version: 1,
  });

  const document = {
    v: 1, name: "Kitchen drawer", has_photo: true,
    lines: [
      { id: LINE, kind: "money", name: "PLN kitchen", currency: "PLN", exponent: 2 },
      { id: "l2", kind: "countable", name: "Glass balls", unit: "balls" },
      { id: "l3", kind: "single", name: "Passport", text: "expires 2031" },
    ],
    verifications: [{ id: "v1", author_id: alice.id, server_time: "2026-08-28T12:30:00.000Z", comment: "counted with Bob", lines: [{ line_id: LINE, balance: 10000, head_seq: 4 }, { line_id: "l3", present: true }] }],
  };
  // A tiny valid JPEG (1x1) so the photo record is real image bytes.
  const photo = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="), (c) => c.charCodeAt(0));

  const records: Array<{ identity: RecordIdentity; sealed: ReturnType<typeof sealedJson>; plaintext: unknown }> = [];
  for (const e of [e1, e2, e3, e4]) {
    const id = ident("entry", e.id, 1, e.author_id);
    records.push({ identity: id, sealed: sealedJson(await sealEntry(k1, id, e)), plaintext: e });
  }
  const docId = ident("document", DRAWER, 1, alice.id);
  records.push({ identity: docId, sealed: sealedJson(await sealDocument(k1, docId, document)), plaintext: document });
  const photoId = ident("photo", DRAWER, 1, alice.id);
  records.push({ identity: photoId, sealed: sealedJson(await sealPhoto(k1, photoId, photo)), plaintext: { photo_b64: toB64(photo) } });
  // Rotation: e1 resealed under key_version 2.
  const e1Id = ident("entry", "e1", 1, alice.id);
  const rotated = await reseal(k1, k2, e1Id, await sealEntry(k1, e1Id, e1), 2);
  records.push({ identity: rotated.identity, sealed: sealedJson(rotated.sealed), plaintext: e1 });

  const archivePayload = { format: "petty-export", v: 1, exported_at: "2026-08-28T13:00:00.000Z", drawers: [{ id: DRAWER, document, entries: [e1, e2, e3, e4] }] };
  const archivePassword = "export password 2026";
  const archive = await sealArchive(archivePassword, archivePayload);

  const strip = ({ keys: _k, ...rest }: Awaited<ReturnType<typeof user>>) => { void _k; return rest; };
  await writeFile(OUT + "users.json", JSON.stringify({ format: "petty-corpus-users", v: 1, users: [strip(alice), strip(bob)] }, null, 2));
  await writeFile(OUT + "drawer.json", JSON.stringify({
    format: "petty-corpus-drawer", v: 1, drawer_id: DRAWER, line_id: LINE,
    keys: { "1": await rawKey(k1), "2": await rawKey(k2) }, wraps, records,
    chain: ["e1", "e2", "e3", "e4"],
  }, null, 2));
  await writeFile(OUT + "archive.json", JSON.stringify({ format: "petty-corpus-archive", v: 1, password: archivePassword, payload: archivePayload, archive }, null, 2));
  process.stdout.write(`corpus v1 written to ${OUT}\n`);
  void utf8;
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
