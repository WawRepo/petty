import { LedgerError } from "./errors.js";
import type { LedgerEntry } from "./types.js";

export type FoldSkipCode =
  | "reverse_target_missing"      // target not in the window: older than the checkpoint, or never existed
  | "reverse_target_not_reversible" // target is an Adjust or a Reverse
  | "reverse_duplicate"           // target already reversed
  | "reverse_amount_mismatch"     // amount is not the exact opposite of the target's
  | "adjust_negative";            // a counted value below zero is impossible

export interface FoldSkip {
  readonly entry: LedgerEntry;
  readonly code: FoldSkipCode;
}

export interface FoldResult {
  readonly balance: number;
  /** The Adjust the fold started from, or null when the line has never been adjusted. */
  readonly checkpoint: LedgerEntry | null;
  /** Entries after the checkpoint that changed the balance, in seq order. */
  readonly applied: readonly LedgerEntry[];
  /** Entries after the checkpoint that were ignored, with the reason. Non-empty means something is wrong and must be shown. */
  readonly skipped: readonly FoldSkip[];
  /** Ids of entries cancelled by an applied Reverse. */
  readonly reversed: ReadonlySet<string>;
  /** Id → id of the Reverse that cancelled it. */
  readonly reversedBy: ReadonlyMap<string, string>;
  readonly negative: boolean;
  /** Highest seq seen, or null for an empty log. */
  readonly headSeq: number | null;
}

/** Sorts by seq and rejects duplicate seqs or entries from more than one line. */
export function orderEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (!Number.isInteger(e.seq) || e.seq < 1) throw new LedgerError("bad_seq", { entry_id: e.entry.id });
    if (i > 0 && sorted[i - 1]!.seq === e.seq) throw new LedgerError("duplicate_seq", { seq: e.seq });
    if (e.entry.line_id !== sorted[0]!.entry.line_id) throw new LedgerError("line_mismatch", { entry_id: e.entry.id });
  }
  return sorted;
}

export function lastCheckpointIndex(sorted: readonly LedgerEntry[]): number {
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i]!.entry.op === "adjust") return i;
  return -1;
}

/**
 * The balance of one line (CLAUDE.md rule 6). Starts at the latest Adjust and
 * applies later Add / Withdraw / Reverse in seq order. Entries before the
 * checkpoint are ignored entirely. A Reverse is applied as its signed amount,
 * but only when its target is in the window, is an Add or Withdraw, has not
 * been reversed already, and the amounts are exact opposites (SPEC-ISSUES A4).
 */
export function fold(entries: readonly LedgerEntry[]): FoldResult {
  const sorted = orderEntries(entries);
  const cp = lastCheckpointIndex(sorted);
  const checkpoint = cp >= 0 ? sorted[cp]! : null;
  const window = sorted.slice(cp + 1);
  const byId = new Map<string, LedgerEntry>();
  for (const e of window) byId.set(e.entry.id, e);

  let balance = 0;
  const skipped: FoldSkip[] = [];
  if (checkpoint) {
    if (checkpoint.entry.amount < 0) skipped.push({ entry: checkpoint, code: "adjust_negative" });
    else balance = checkpoint.entry.amount;
  }
  const applied: LedgerEntry[] = [];
  const reversed = new Set<string>();
  const reversedBy = new Map<string, string>();

  for (const e of window) {
    const p = e.entry;
    switch (p.op) {
      case "add":
      case "withdraw":
        balance += p.amount;
        applied.push(e);
        break;
      case "reverse": {
        const target = p.reverses ? byId.get(p.reverses) : undefined;
        if (!target) { skipped.push({ entry: e, code: "reverse_target_missing" }); break; }
        if (target.entry.op !== "add" && target.entry.op !== "withdraw") { skipped.push({ entry: e, code: "reverse_target_not_reversible" }); break; }
        if (reversed.has(target.entry.id)) { skipped.push({ entry: e, code: "reverse_duplicate" }); break; }
        if (p.amount !== -target.entry.amount) { skipped.push({ entry: e, code: "reverse_amount_mismatch" }); break; }
        balance += p.amount;
        reversed.add(target.entry.id);
        reversedBy.set(target.entry.id, p.id);
        applied.push(e);
        break;
      }
      case "adjust":
        // unreachable: the window starts after the last adjust
        break;
    }
  }
  return {
    balance,
    checkpoint,
    applied,
    skipped,
    reversed,
    reversedBy,
    negative: balance < 0,
    headSeq: sorted.length ? sorted[sorted.length - 1]!.seq : null,
  };
}
