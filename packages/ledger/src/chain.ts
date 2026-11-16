import { hashEntry } from "@petty/crypto";
import { orderEntries } from "./fold.js";
import type { LedgerEntry } from "./types.js";

/** The newest entry a client has seen on a line. Kept in IndexedDB; a hash, not content. */
export interface PinnedHead {
  readonly line_id: string;
  readonly seq: number;
  readonly hash: string;
  /** Hash of the first entry of the window the head was pinned in (since PETTY-444). The same first entry later is the same window. */
  readonly start?: string;
  /**
   * PETTY-500: hashes of rows before the window that entries in it link to, found and checked there when the head was
   * pinned. They stand for those rows in a later check of the same window (the same `start`), also offline.
   */
  readonly before?: readonly string[];
}

export type ChainStatus = "ok" | "broken" | "truncated";
export type ChainProblemCode =
  | "prev_unresolved"   // prev_hash points at nothing in the window (and this is not the window's first entry), nor before it
  | "prev_not_older"    // prev_hash points at an entry with a higher or equal seq
  | "prev_not_counted"  // prev_hash points before the window, at a row the count that starts it did not see (PETTY-500)
  | "genesis_repeated"  // null prev_hash although the same author already had an entry on this line
  | "window_start_linked" // the window's first entry is no count, yet it links to an entry before it
  | "checkpoint_flag_mismatch" // the server's plain "count" flag says otherwise than the sealed operation
  | "pinned_head_missing" // the pinned head is not among the rows
  | "pinned_head_changed" // the pinned head is not among the rows, and another entry has its seq
  | "pinned_head_renumbered"; // the pinned head is among the rows, under another seq

export interface ChainProblem {
  readonly entry_id: string | null;
  readonly code: ChainProblemCode;
}

export interface ChainResult {
  readonly status: ChainStatus;
  readonly problems: readonly ChainProblem[];
  /** The head to pin after this check, or null for an empty log. */
  readonly head: PinnedHead | null;
  /**
   * True when the pinned head, or a row an entry links to, is not in the window but may lie before the count the
   * window starts at: call again with the rows before the window as `older`, more of them each time, until it is
   * found or there are none left.
   */
  readonly searchOlder: boolean;
}

/** Problems that "Accept as is" clears: it pins the head as it is now. A link problem stays until a count starts a new window. */
export function isHeadProblem(p: ChainProblem): boolean {
  return p.code === "pinned_head_missing" || p.code === "pinned_head_changed" || p.code === "pinned_head_renumbered";
}

/**
 * Verifies the hash links of one line's fetched window (SPEC-ISSUES A2).
 * The log is a tree: concurrent writers may share a prev. Rules:
 *  - every prev_hash must resolve to a fetched entry with a lower seq, except
 *    for the lowest-seq entry of the window, whose prev may lie before it;
 *  - in a window that starts at a count, an entry written from a view older than that count links to a row before it
 *    (PETTY-500). That row must be among `older`, the rows before the window, at or before the row the count links to
 *    (the count saw it), and its own link must not point at a row that comes after it (a row moved back out of the
 *    window). Until it is found, the rows before the window are asked for;
 *  - that lowest-seq entry is a count, or the line's first entry, which has no prev_hash (PETTY-448);
 *  - a null prev_hash (genesis) is allowed unless the same author already has
 *    an older entry in the window. An entry a tool signed is exempt: tools before PETTY-445 never linked;
 *  - a row's "count" flag from the server says what the sealed entry says (PETTY-448);
 *  - the pinned head must still be there. It is found by its hash, because the seq is the server's
 *    plain number (PETTY-444), and it must still have its seq. A head that is not in the window is
 *    accepted only before a count that started a new window: that count links straight to it, or it
 *    is among `older`, the rows before the window.
 * A chain alone cannot see tail truncation; the pinned head can.
 */
export async function verifyChain(entries: readonly LedgerEntry[], pinned: PinnedHead | null = null, older: readonly LedgerEntry[] = []): Promise<ChainResult> {
  if (entries.length === 0) {
    if (pinned) return { status: "truncated", problems: [{ entry_id: null, code: "pinned_head_missing" }], head: null, searchOlder: false };
    return { status: "ok", problems: [], head: null, searchOlder: false };
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
  const first = sorted[0]!;
  const minSeq = first.seq;
  const start = hashes.get(first.entry.id)!;
  const counted = first.entry.op === "adjust";
  // the rows before the window, by hash: only a window that starts at a count has any (before it, the window is the whole line)
  const before = new Map<string, LedgerEntry>();
  if (counted) for (const o of older) if (o.seq < minSeq && o.entry.line_id === first.entry.line_id) before.set(await hashEntry(o.entry), o);
  // PETTY-500: rows before this same window that an earlier check found for its links
  const known = new Set(pinned && pinned.line_id === first.entry.line_id && pinned.start === start ? (pinned.before ?? []) : []);
  // the newest row the count saw is the one it links to; a count with no link saw none
  const saw = !counted ? null : first.entry.prev_hash === null ? 0 : (before.get(first.entry.prev_hash)?.seq ?? null);
  const outside = new Set<string>(); // rows before the window that entries link to, found and checked
  let lookBack = false;
  if (!counted && first.entry.prev_hash !== null) problems.push({ entry_id: first.entry.id, code: "window_start_linked" });
  const seenAuthors = new Set<string>();
  for (const e of sorted) {
    if (e.is_checkpoint !== undefined && e.is_checkpoint !== (e.entry.op === "adjust")) problems.push({ entry_id: e.entry.id, code: "checkpoint_flag_mismatch" });
    const prev = e.entry.prev_hash;
    if (prev === null) {
      if (seenAuthors.has(e.entry.author_id) && !e.by_token) problems.push({ entry_id: e.entry.id, code: "genesis_repeated" });
    } else {
      const target = byHash.get(prev);
      if (target) {
        if (target.seq >= e.seq) problems.push({ entry_id: e.entry.id, code: "prev_not_older" });
      } else if (e.seq !== minSeq) {
        if (!counted) problems.push({ entry_id: e.entry.id, code: "prev_unresolved" });
        else if (known.has(prev)) outside.add(prev);
        else {
          const t = before.get(prev);
          if (!t || saw === null) { problems.push({ entry_id: e.entry.id, code: "prev_unresolved" }); lookBack = true; }
          else if (t.seq > saw) problems.push({ entry_id: e.entry.id, code: "prev_not_counted" });
          else {
            const tPrev = t.entry.prev_hash === null ? undefined : (byHash.get(t.entry.prev_hash) ?? before.get(t.entry.prev_hash));
            if (tPrev && tPrev.seq >= t.seq) problems.push({ entry_id: t.entry.id, code: "prev_not_older" });
            else outside.add(prev);
          }
        }
      }
    }
    seenAuthors.add(e.entry.author_id);
  }
  let truncated = false;
  let searchHead = false;
  const last = sorted[sorted.length - 1]!;
  if (pinned && pinned.line_id === last.entry.line_id) {
    const here = byHash.get(pinned.hash);
    // Only a count that was not the window's start when the head was pinned can have put the head before the window.
    const newWindow = !here && counted && pinned.start !== start;
    if (here) {
      if (here.seq !== pinned.seq) problems.push({ entry_id: here.entry.id, code: "pinned_head_renumbered" });
    } else if (newWindow && first.entry.prev_hash === pinned.hash) {
      // the count was made right on top of the pinned head
    } else {
      const there = newWindow ? before.get(pinned.hash) : undefined;
      if (there) {
        if (there.seq !== pinned.seq) problems.push({ entry_id: there.entry.id, code: "pinned_head_renumbered" });
        // an entry that links to a row which now comes after it was moved back, out of the window
        const target = there.entry.prev_hash === null ? undefined : (byHash.get(there.entry.prev_hash) ?? before.get(there.entry.prev_hash));
        if (target && target.seq >= there.seq) problems.push({ entry_id: there.entry.id, code: "prev_not_older" });
      } else {
        truncated = true;
        searchHead = newWindow;
        const at = sorted.find((e) => e.seq === pinned.seq);
        problems.push(at ? { entry_id: at.entry.id, code: "pinned_head_changed" } : { entry_id: null, code: "pinned_head_missing" });
      }
    }
  }
  const unique = problems.filter((p, i) => problems.findIndex((q) => q.entry_id === p.entry_id && q.code === p.code) === i);
  const head: PinnedHead = { line_id: last.entry.line_id, seq: last.seq, hash: hashes.get(last.entry.id)!, start, ...(outside.size ? { before: [...outside].sort() } : {}) };
  const status: ChainStatus = truncated ? "truncated" : unique.length ? "broken" : "ok";
  return { status, problems: unique, head, searchOlder: searchHead || lookBack };
}
