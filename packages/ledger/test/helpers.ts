import { exportPublicKeys, generateUserKeys, hashEntry, signEntry, signingKeyId, type EntryOp, type EntryPayloadV1, type SignedEntryV1 } from "@petty/crypto";
import type { LedgerEntry } from "../src/index.js";

export const DRAWER = "d1";
export const LINE = "l1";

export interface Actor { id: string; sigKeyId: string; sign: (p: EntryPayloadV1) => Promise<SignedEntryV1> }

export async function actor(id: string): Promise<Actor> {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  return { id, sigKeyId: await signingKeyId(pub.ecdsa), sign: (p) => signEntry(p, keys.ecdsa.privateKey) };
}

let counter = 0;
export function unsignedEntry(a: Actor, op: EntryOp, amount: number, over: Partial<EntryPayloadV1> = {}): EntryPayloadV1 {
  return {
    v: 1, id: over.id ?? `e${++counter}`, drawer_id: DRAWER, line_id: LINE, op, amount, exponent: 2, comment: "",
    logged_at: "2026-08-28T10:00:00.000Z", reverses: null, prev_hash: null, delta_hint: null, author_id: a.id, sig_key_id: a.sigKeyId, ...over,
  };
}

/** Builds a signed, seq-numbered, hash-linked log in the given order. */
export async function log(a: Actor, ops: Array<[EntryOp, number, Partial<EntryPayloadV1>?]>): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let prev: string | null = null;
  for (const [op, amount, over] of ops) {
    const signed = await a.sign(unsignedEntry(a, op, amount, { prev_hash: prev, ...over }));
    out.push({ seq: out.length + 1, received_at: "2026-08-28T10:00:00.000Z", entry: signed });
    prev = await hashEntry(signed);
  }
  return out;
}

/** Unsigned-but-shaped entries for pure fold tests (fold never checks signatures). */
export function fake(seq: number, op: EntryOp, amount: number, over: Partial<EntryPayloadV1> = {}): LedgerEntry {
  return {
    seq, received_at: "2026-08-28T10:00:00.000Z",
    entry: { v: 1, id: over.id ?? `f${seq}`, drawer_id: DRAWER, line_id: LINE, op, amount, exponent: 2, comment: "", logged_at: "2026-08-28T10:00:00.000Z",
      reverses: null, prev_hash: null, delta_hint: null, author_id: "u", sig_key_id: "k", sig: "AA==", ...over },
  };
}
