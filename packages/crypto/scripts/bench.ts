import { ARGON2ID_V1, argon2idDerive, generateDrawerKey, open, seal, utf8, randomBytes, type RecordIdentity } from "../src/index.js";

async function time(label: string, runs: number, fn: () => Promise<unknown>) {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  process.stdout.write(`${label.padEnd(44)} median ${t[Math.floor(t.length / 2)]!.toFixed(1).padStart(8)} ms  (min ${t[0]!.toFixed(1)}, max ${t[t.length - 1]!.toFixed(1)})\n`);
}

const salt = randomBytes(16);
await time(`argon2id m=${ARGON2ID_V1.m}KiB t=${ARGON2ID_V1.t} p=${ARGON2ID_V1.p}`, 3, () => argon2idDerive("a passphrase of typical length", salt, ARGON2ID_V1));

const key = await generateDrawerKey();
const id: RecordIdentity = { record_type: "entry", record_id: "e", drawer_id: "d", line_id: "l", author_id: "u", key_version: 1, schema_version: 1 };
const pt = utf8(JSON.stringify({ v: 1, amount: 12345, comment: "a typical comment" }));
const sealed = await seal(key, id, pt);
await time("seal 1000 entries (256 B bucket)", 3, async () => { for (let i = 0; i < 1000; i++) await seal(key, id, pt); });
await time("open 1000 entries", 3, async () => { for (let i = 0; i < 1000; i++) await open(key, id, sealed); });
const doc: RecordIdentity = { ...id, record_type: "document", line_id: null };
const big = randomBytes(300 * 1024);
await time("seal+open one 300 KB document/photo", 5, async () => { await open(key, doc, await seal(key, doc, big)); });
process.stdout.write("\nTarget: argon2id ≤ 1500 ms on a 2020 mid-range phone (this machine is faster; scale x4–x6).\n");
