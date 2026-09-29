import { foldText, lineTagsOf, type Line } from "@petty/ledger";
import type { DrawerView } from "./drawers.js";
import { placeOfView } from "./places.js";

/**
 * Home search (PETTY-47). Runs on the device only: line names and single-item
 * texts are plaintext in memory once a drawer is decrypted, and nothing about the
 * query is sent or logged. Case- and accent-insensitive substring match.
 * An item's tags count too (PETTY-154), and its currency or unit (PETTY-279: "usd" found nothing).
 */
export const fold = foldText;

export function lineMatches(line: Line, q: string): boolean {
  if (fold(line.name).includes(q)) return true;
  if (lineTagsOf(line).some((tg) => fold(tg).includes(q))) return true;
  if (line.kind === "money") return fold(line.currency).includes(q);
  if (line.kind === "countable") return !!line.unit && fold(line.unit).includes(q);
  return fold(line.text).includes(q);
}

export interface SearchResult { readonly hits: ReadonlyMap<string, readonly Line[]>; readonly lines: number; readonly drawers: number }

export function searchDrawers(views: Iterable<DrawerView>, query: string): SearchResult {
  const q = fold(query.trim());
  const hits = new Map<string, Line[]>();
  let lines = 0;
  if (!q) return { hits, lines: 0, drawers: 0 };
  for (const v of views) {
    if (!v.doc) continue;
    // PETTY-279: a drawer found by its own name or its place shows everything in it ("car", "kitchen")
    const whole = fold(v.doc.name).includes(q) || placeOfView(v).some((p) => fold(p).includes(q));
    const found = whole ? [...v.doc.lines] : v.doc.lines.filter((l) => lineMatches(l, q));
    if (found.length || whole) { hits.set(v.summary.id, found); lines += found.length; }
  }
  return { hits, lines, drawers: hits.size };
}
