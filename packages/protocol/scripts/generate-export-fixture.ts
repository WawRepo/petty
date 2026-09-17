/**
 * Writes corpus/export-v1.json: a sealed export archive with a known password and
 * its plaintext, in the app's ExportPayload shape. RUN ONCE; every future build
 * must open it (test/export-corpus.test.ts). Refuses to overwrite.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { exportPublicKeys, generateUserKeys, hashEntry, sealArchive, signEntry, signingKeyId, type EntryPayloadV1 } from "@petty/crypto";
import { ExportPayload } from "../src/index.js";

const out = fileURLToPath(new URL("../corpus/export-v1.json", import.meta.url));
try { await access(out); throw new Error("refusing to overwrite corpus/export-v1.json"); } catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
await mkdir(fileURLToPath(new URL("../corpus/", import.meta.url)), { recursive: true });

const keys = await generateUserKeys();
const pub = await exportPublicKeys(keys);
const me = "a0000000-0000-4000-8000-000000000001";
const drawer = "d0000000-0000-4000-8000-000000000001";
const line = "10000000-0000-4000-8000-000000000001";
const base = (over: Partial<EntryPayloadV1>): EntryPayloadV1 => ({ v: 1, id: "", drawer_id: drawer, line_id: line, op: "add", amount: 0, exponent: 2, comment: "", logged_at: "2026-08-28T12:00:00.000Z", reverses: null, prev_hash: null, delta_hint: null, author_id: me, sig_key_id: await0, ...over });
const await0 = await signingKeyId(pub.ecdsa);
const e1 = await signEntry(base({ id: "e0000000-0000-4000-8000-000000000001", amount: 10000, comment: "starting balance" }), keys.ecdsa.privateKey);
const e2 = await signEntry(base({ id: "e0000000-0000-4000-8000-000000000002", op: "withdraw", amount: -2550, comment: "zażółć gęślą jaźń", prev_hash: await hashEntry(e1) }), keys.ecdsa.privateKey);
const e3 = await signEntry(base({ id: "e0000000-0000-4000-8000-000000000003", op: "adjust", amount: 7450, delta_hint: 0, prev_hash: await hashEntry(e2) }), keys.ecdsa.privateKey);
const payload = ExportPayload.parse({
  format: "petty-export", v: 1, exported_at: "2026-08-28T13:00:00.000Z", exported_by: { id: me, display_name: "Alice" },
  drawers: [{
    id: drawer,
    document: { v: 1, name: "Kitchen", has_photo: false, lines: [{ id: line, kind: "money", name: "PLN kitchen", currency: "PLN", exponent: 2 }, { id: "10000000-0000-4000-8000-000000000002", kind: "single", name: "Passport", text: "expires 2031" }], verifications: [{ id: "v0000000-0000-4000-8000-000000000001", author_id: me, logged_at: "2026-08-28T12:30:00.000Z", comment: "counted", lines: [{ line_id: line, kind: "money", balance: 7450, present: null, head_seq: 3 }, { line_id: "10000000-0000-4000-8000-000000000002", kind: "single", balance: null, present: true, head_seq: null }] }] },
    photo_b64: null,
    members: [{ id: me, display_name: "Alice", role: "owner" }],
    entries: [{ seq: 1, received_at: "2026-08-28T12:00:01.000Z", entry: e1 }, { seq: 2, received_at: "2026-08-28T12:00:02.000Z", entry: e2 }, { seq: 3, received_at: "2026-08-28T12:00:03.000Z", entry: e3 }],
  }],
});
const password = "export password 2026";
await writeFile(out, JSON.stringify({ format: "petty-corpus-export", v: 1, password, payload, archive: await sealArchive(password, payload), ecdsa_pub: pub.ecdsa }, null, 2));
process.stdout.write(`written ${out}\n`);
