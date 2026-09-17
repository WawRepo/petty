import { hashEntry } from "@petty/crypto";
import { orderEntries } from "./fold.js";
import type { LedgerEntry } from "./types.js";

/** The newest entry a client has seen on a line. Kept in IndexedDB; a hash, not content. */
export interface PinnedHead {
  readonly line_id: string;
  readonly seq: number;
  readonly hash: string;
}

export type ChainStatus = "ok" | "broken" | "truncated";
export type ChainProblemCode =
  | "prev_unresolved"   // prev_hash points at nothing in the window (and this is not the window's first entry)
  | "prev_not_older"    // prev_hash points at an entry with a higher or equal seq
  | "genesis_repeated"  // null prev_hash although the same author already had an entry on this line
  | "pinned_head_missing" // the pinned head's seq is inside the window but no entry has it
  | "pinned_head_changed"; // the entry at the pinned seq hashes differently

export interface ChainProblem {
  readonly entry_id: string | null;
  readonly code: ChainProblemCode;
}

export interface ChainResult {
  readonly status: ChainStatus;
  readonly problems: readonly ChainProblem[];
  /** The head to pin after this check, or null for an empty log. */
  readonly head: PinnedHead | null;
}

/**
 * Verifies the hash links of one line's fetched window (SPEC-ISSUES A2).
 * The log is a tree: concurrent writers may share a prev. Rules:
 *  - every prev_hash must resolve to a fetched entry with a lower seq, except
 *    for the lowest-seq entry of the window, whose prev may lie before it;
 *  - a null prev_hash (genesis) is allowed unless the same author already has
 *    an older entry in the window;
 *  - if a pinned head falls inside the window it must still be there, unchanged.
 * A chain alone cannot see tail truncation; the pinned head can.
 */
export async function verifyChain(entries: readonly LedgerEntry[], pinned: PinnedHead | null = null): Promise<ChainResult> {
  if (entries.length === 0) {
    if (pinned) return { status: "truncated", problems: [{ entry_id: null, code: "pinned_head_missing" }], head: null };
    return { status: "ok", problems: [], head: null };
  }
  const sorted = orderEntries(entries);
  const hashes = new Map<string, string>(); // entry id → hash
  const byHash = new Map<string, LedgerEntry>();
  for (const e of sorted) {
    const h = await hashEntry(e.entry);
    hashes.set(e.entry.id, h);
    byHash.set(h, e);
  }
  const problems: ChainProblem[] = [];
  const minSeq = sorted[0]!.seq;
  const seenAuthors = new Set<string>();
  for (const e of sorted) {
    const prev = e.entry.prev_hash;
    if (prev === null) {
      if (seenAuthors.has(e.entry.author_id)) problems.push({ entry_id: e.entry.id, code: "genesis_repeated" });
    } else {
      const target = byHash.get(prev);
      if (!target) {
        if (e.seq !== minSeq) problems.push({ entry_id: e.entry.id, code: "prev_unresolved" });
      } else if (target.seq >= e.seq) {
        problems.push({ entry_id: e.entry.id, code: "prev_not_older" });
      }
    }
    seenAuthors.add(e.entry.author_id);
  }
  let truncated = false;
  const last = sorted[sorted.length - 1]!;
  if (pinned && pinned.line_id === last.entry.line_id && pinned.seq >= minSeq) {
    const at = sorted.find((e) => e.seq === pinned.seq);
    if (!at) { truncated = true; problems.push({ entry_id: null, code: "pinned_head_missing" }); }
    else if (hashes.get(at.entry.id) !== pinned.hash) { truncated = true; problems.push({ entry_id: at.entry.id, code: "pinned_head_changed" }); }
  }
  const head: PinnedHead = { line_id: last.entry.line_id, seq: last.seq, hash: hashes.get(last.entry.id)! };
  const status: ChainStatus = truncated ? "truncated" : problems.length ? "broken" : "ok";
  return { status, problems, head };
}
