import { LedgerError } from "./errors.js";
import { assertCurrencyCode, canChangeKind } from "./rules.js";
import { MAX_EXPONENT } from "./money.js";
import type { DrawerDocument, Line, LineExtras, MoneyLine, Verification } from "./types.js";

export const MAX_NAME = 120;
export const MAX_TEXT = 4000;
export const MAX_LINES = 200;

export type DocumentOp =
  | { readonly type: "rename_drawer"; readonly name: string }
  | { readonly type: "set_tags"; readonly tags: readonly string[] }
  | { readonly type: "set_has_photo"; readonly has_photo: boolean }
  | { readonly type: "set_icon"; readonly icon: string | null }
  | { readonly type: "set_line_icon"; readonly line_id: string; readonly icon: string | null }
  | { readonly type: "set_line_tags"; readonly line_id: string; readonly tags: readonly string[] }
  | { readonly type: "set_line_counted"; readonly line_id: string; readonly counted: boolean }
  | { readonly type: "add_line"; readonly line: Line; readonly index?: number }
  | { readonly type: "rename_line"; readonly line_id: string; readonly name: string }
  | { readonly type: "set_currency"; readonly line_id: string; readonly currency: string }
  | { readonly type: "set_unit"; readonly line_id: string; readonly unit: string }
  | { readonly type: "set_text"; readonly line_id: string; readonly text: string }
  | { readonly type: "change_kind"; readonly line_id: string; readonly line: Line }
  | { readonly type: "remove_line"; readonly line_id: string }
  | { readonly type: "move_line"; readonly line_id: string; readonly to: number }
  | { readonly type: "move_up"; readonly line_id: string }
  | { readonly type: "move_down"; readonly line_id: string }
  | { readonly type: "reorder"; readonly ids: readonly string[] }
  | { readonly type: "append_verification"; readonly verification: Verification };

export interface OpContext {
  /** Whether the line has any entries. Needed only for change_kind. */
  readonly lineHasEntries: (lineId: string) => boolean;
}

function name(s: string): string {
  const t = s.trim();
  if (t.length === 0 || t.length > MAX_NAME) throw new LedgerError("bad_name");
  return t;
}

export function newDocument(drawerName: string): DrawerDocument {
  return { v: 1, name: name(drawerName), has_photo: false, lines: [], verifications: [] };
}

/** An icon slug: the app maps it to a drawing; the ledger only keeps it short and plain. */
export const ICON_SLUG = /^[a-z0-9-]{1,40}$/;
function assertIcon(x: unknown): string {
  if (typeof x !== "string" || !ICON_SLUG.test(x)) throw new LedgerError("bad_icon");
  return x;
}

/** The optional extras of a line (PETTY-64), validated and with absent-as-default fields dropped. */
function lineExtras(l: LineExtras): LineExtras {
  const out: { icon?: string; tags?: readonly string[]; counted?: boolean } = {};
  if (l.icon !== undefined) out.icon = assertIcon(l.icon);
  if (l.tags !== undefined) {
    if (!Array.isArray(l.tags) || l.tags.some((t) => typeof t !== "string")) throw new LedgerError("bad_tags");
    const tags = normalizeTags(l.tags);
    if (tags.length) out.tags = tags;
  }
  if (l.counted !== undefined) {
    if (typeof l.counted !== "boolean") throw new LedgerError("bad_counted");
    if (!l.counted) out.counted = false;
  }
  return out;
}

function assertLine(l: Line): Line {
  if (typeof l.id !== "string" || l.id.length === 0) throw new LedgerError("bad_line_id");
  const n = name(l.name);
  const extras = lineExtras(l);
  switch (l.kind) {
    case "money": {
      if (!Number.isInteger(l.exponent) || l.exponent < 0 || l.exponent > MAX_EXPONENT) throw new LedgerError("bad_exponent");
      return { id: l.id, kind: "money", name: n, currency: assertCurrencyCode(l.currency), exponent: l.exponent, ...extras };
    }
    case "countable":
      if (typeof l.unit !== "string" || l.unit.length > MAX_NAME) throw new LedgerError("bad_unit");
      return { id: l.id, kind: "countable", name: n, unit: l.unit.trim(), ...extras };
    case "single":
      if (typeof l.text !== "string" || l.text.length > MAX_TEXT) throw new LedgerError("bad_text");
      return { id: l.id, kind: "single", name: n, text: l.text, ...extras };
    default:
      throw new LedgerError("bad_kind");
  }
}

export function lineTagsOf(line: Line): readonly string[] { return line.tags ?? []; }
/** False only when the line was switched out of the totals (PETTY-64). */
export function lineCounted(line: Line): boolean { return line.counted !== false; }
export function iconOf(doc: DrawerDocument): string | null { return doc.icon ?? null; }

function indexOf(doc: DrawerDocument, lineId: string): number {
  const i = doc.lines.findIndex((l) => l.id === lineId);
  if (i < 0) throw new LedgerError("line_not_found", { line_id: lineId });
  return i;
}

function replaceLine(doc: DrawerDocument, i: number, line: Line): DrawerDocument {
  const lines = [...doc.lines];
  lines[i] = line;
  return { ...doc, lines };
}

function moveTo(doc: DrawerDocument, i: number, to: number): DrawerDocument {
  const lines = [...doc.lines];
  const [l] = lines.splice(i, 1);
  const bounded = Math.max(0, Math.min(lines.length, to));
  lines.splice(bounded, 0, l!);
  return { ...doc, lines };
}

/**
 * Applies one operation and returns a new document (the input is not mutated).
 * Operations, not snapshots, are what the offline outbox stores, so they can be
 * re-applied on a newer version after a 409 (SPEC-ISSUES B4). An op that no
 * longer applies throws a LedgerError with a code the UI can explain.
 */
/** Case- and accent-insensitive key for matching user text (tags, search). NFD, marks stripped, lower-cased. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 24;
/**
 * Tags (PETTY-52): trimmed, inner whitespace collapsed, cut to MAX_TAG_LENGTH,
 * de-duplicated by foldText (the first spelling wins), at most MAX_TAGS, empties dropped.
 */
export function normalizeTags(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH).trim();
    if (!t) continue;
    const k = foldText(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
export function tagsOf(doc: DrawerDocument): readonly string[] { return doc.tags ?? []; }
/**
 * Places (PETTY-59): the tags of a drawer are read as an ORDERED path — the room first, then the shelf,
 * then the box. The wire format is unchanged (`tags`, `set_tags`); only the reading of the order is new.
 * A place is typed as words separated by spaces ("kitchen shelf"); commas and slashes are accepted too.
 */
export function parsePlace(text: string): string[] { return text.split(/[\s,/>›]+/).filter(Boolean); }
export function placeLabel(path: readonly string[]): string { return path.join(" › "); }
export function hasTag(doc: DrawerDocument, folded: string): boolean { return tagsOf(doc).some((t) => foldText(t) === folded); }

export function applyOp(doc: DrawerDocument, op: DocumentOp, ctx: OpContext): DrawerDocument {
  switch (op.type) {
    case "rename_drawer":
      return { ...doc, name: name(op.name) };
    case "set_tags": {
      const tags = normalizeTags(op.tags);
      if (tags.length === 0) { const rest = { ...doc }; delete (rest as { tags?: readonly string[] }).tags; return rest; }
      return { ...doc, tags };
    }
    case "set_has_photo":
      return { ...doc, has_photo: op.has_photo };
    case "set_icon": {
      if (op.icon === null) { const rest = { ...doc }; delete (rest as { icon?: string }).icon; return rest; }
      return { ...doc, icon: assertIcon(op.icon) };
    }
    case "set_line_icon": {
      const i = indexOf(doc, op.line_id);
      const { icon: _drop, ...rest } = doc.lines[i]!;
      void _drop;
      return replaceLine(doc, i, assertLine(op.icon === null ? rest as Line : { ...rest, icon: op.icon } as Line));
    }
    case "set_line_tags": {
      const i = indexOf(doc, op.line_id);
      const { tags: _drop, ...rest } = doc.lines[i]!;
      void _drop;
      return replaceLine(doc, i, assertLine({ ...rest, tags: op.tags } as Line));
    }
    case "set_line_counted": {
      const i = indexOf(doc, op.line_id);
      const { counted: _drop, ...rest } = doc.lines[i]!;
      void _drop;
      return replaceLine(doc, i, assertLine({ ...rest, counted: op.counted } as Line));
    }
    case "add_line": {
      if (doc.lines.some((l) => l.id === op.line.id)) throw new LedgerError("line_exists", { line_id: op.line.id });
      if (doc.lines.length >= MAX_LINES) throw new LedgerError("too_many_lines");
      const line = assertLine(op.line);
      const lines = [...doc.lines];
      lines.splice(op.index === undefined ? lines.length : Math.max(0, Math.min(lines.length, op.index)), 0, line);
      return { ...doc, lines };
    }
    case "rename_line": {
      const i = indexOf(doc, op.line_id);
      return replaceLine(doc, i, { ...doc.lines[i]!, name: name(op.name) });
    }
    case "set_currency": {
      const i = indexOf(doc, op.line_id);
      const l = doc.lines[i]!;
      if (l.kind !== "money") throw new LedgerError("not_money_line", { line_id: op.line_id });
      // The exponent is deliberately untouched (CLAUDE.md rule 5).
      return replaceLine(doc, i, { ...l, currency: assertCurrencyCode(op.currency) });
    }
    case "set_unit": {
      const i = indexOf(doc, op.line_id);
      const l = doc.lines[i]!;
      if (l.kind !== "countable") throw new LedgerError("not_countable_line", { line_id: op.line_id });
      return replaceLine(doc, i, assertLine({ ...l, unit: op.unit }));
    }
    case "set_text": {
      const i = indexOf(doc, op.line_id);
      const l = doc.lines[i]!;
      if (l.kind !== "single") throw new LedgerError("not_single_line", { line_id: op.line_id });
      return replaceLine(doc, i, assertLine({ ...l, text: op.text }));
    }
    case "change_kind": {
      const i = indexOf(doc, op.line_id);
      const l = doc.lines[i]!;
      if (op.line.id !== l.id) throw new LedgerError("bad_line_id");
      if (!canChangeKind(l, ctx.lineHasEntries(l.id))) throw new LedgerError("kind_locked", { line_id: l.id });
      return replaceLine(doc, i, assertLine(op.line));
    }
    case "remove_line": {
      const i = indexOf(doc, op.line_id);
      return { ...doc, lines: doc.lines.filter((_, j) => j !== i) };
    }
    case "move_line":
      return moveTo(doc, indexOf(doc, op.line_id), op.to);
    case "move_up": {
      const i = indexOf(doc, op.line_id);
      return i === 0 ? doc : moveTo(doc, i, i - 1);
    }
    case "move_down": {
      const i = indexOf(doc, op.line_id);
      return i === doc.lines.length - 1 ? doc : moveTo(doc, i, i + 1);
    }
    case "reorder": {
      const ids = new Set(op.ids);
      if (ids.size !== op.ids.length || ids.size !== doc.lines.length || !doc.lines.every((l) => ids.has(l.id))) throw new LedgerError("bad_reorder");
      const byId = new Map(doc.lines.map((l) => [l.id, l]));
      return { ...doc, lines: op.ids.map((id) => byId.get(id)!) };
    }
    case "append_verification": {
      const v = op.verification;
      if (doc.verifications.some((x) => x.id === v.id)) throw new LedgerError("verification_exists", { verification_id: v.id });
      return { ...doc, verifications: [...doc.verifications, v] };
    }
    default:
      throw new LedgerError("unknown_op");
  }
}

export function applyOps(doc: DrawerDocument, ops: readonly DocumentOp[], ctx: OpContext): DrawerDocument {
  return ops.reduce((d, op) => applyOp(d, op, ctx), doc);
}

/** Structural check for a document that came out of a ciphertext. Throws LedgerError("bad_document"). */
export function assertDocumentShape(x: unknown): asserts x is DrawerDocument {
  if (typeof x !== "object" || x === null) throw new LedgerError("bad_document");
  const d = x as Record<string, unknown>;
  if (d["v"] !== 1 || typeof d["name"] !== "string" || typeof d["has_photo"] !== "boolean" || !Array.isArray(d["lines"]) || !Array.isArray(d["verifications"])) {
    throw new LedgerError("bad_document");
  }
  if (d["tags"] !== undefined) {
    const tags = d["tags"];
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.length === 0 || t.length > MAX_TAG_LENGTH) || tags.length > MAX_TAGS) throw new LedgerError("bad_document");
  }
  if (d["icon"] !== undefined && (typeof d["icon"] !== "string" || !ICON_SLUG.test(d["icon"]))) throw new LedgerError("bad_document");
  const ids = new Set<string>();
  for (const l of d["lines"] as Line[]) {
    assertLine(l);
    if (ids.has(l.id)) throw new LedgerError("bad_document");
    ids.add(l.id);
  }
  for (const v of d["verifications"] as Verification[]) {
    if (typeof v.id !== "string" || typeof v.author_id !== "string" || typeof v.logged_at !== "string" || typeof v.comment !== "string" || !Array.isArray(v.lines)) {
      throw new LedgerError("bad_document");
    }
  }
}

export type StalenessStatus = "never" | "verified" | "stale";
export interface Staleness {
  readonly status: StalenessStatus;
  readonly last: Verification | null;
}

/**
 * "Changed since verify" (spec, SPEC-ISSUES B3): both timestamps are stamped by
 * the server on the drawer row — last_write_at by every write of any kind,
 * last_verified_at by a document write flagged as a verification (which is
 * itself a write, so right after it the two are equal). Client clocks are
 * never consulted.
 */
export function staleness(doc: DrawerDocument, drawer: { last_write_at: string; last_verified_at: string | null }): Staleness {
  const last = doc.verifications.length ? doc.verifications[doc.verifications.length - 1]! : null;
  if (!last || drawer.last_verified_at === null) return { status: "never", last: null };
  const w = Date.parse(drawer.last_write_at);
  const v = Date.parse(drawer.last_verified_at);
  if (Number.isNaN(w) || Number.isNaN(v)) throw new LedgerError("bad_timestamp");
  return { status: w > v ? "stale" : "verified", last };
}

export interface LineBalance {
  readonly line: MoneyLine;
  readonly balance: number;
}
export interface DrawerForTotals {
  /** false when the drawer failed to decrypt; its lines are then ignored and the total is marked incomplete */
  readonly ok: boolean;
  readonly moneyLines: readonly LineBalance[];
}
export interface CurrencyTotal {
  readonly code: string;
  readonly exponent: number;
  readonly amount: number;
}
export interface Totals {
  readonly byCurrency: readonly CurrencyTotal[];
  readonly incomplete: boolean;
}

/**
 * Cross-drawer totals by currency code (upper-cased). Countables are excluded
 * by construction. Two lines with the same code but different exponents
 * (a relabelled line) are summed at the larger exponent, exactly.
 * Ordered largest first (compared at a common exponent, ties by code) and
 * without zero totals: the home screen is a glance for "the big pile", and a
 * currency nobody holds any more is noise there. Negatives stay; they are a
 * warning, not noise.
 */
export function totals(drawers: readonly DrawerForTotals[]): Totals {
  const acc = new Map<string, { exponent: number; amount: number }>();
  let incomplete = false;
  for (const d of drawers) {
    if (!d.ok) { incomplete = true; continue; }
    for (const { line, balance } of d.moneyLines) {
      const code = line.currency.trim().toUpperCase();
      const cur = acc.get(code);
      if (!cur) { acc.set(code, { exponent: line.exponent, amount: balance }); continue; }
      const exp = Math.max(cur.exponent, line.exponent);
      const scaled = cur.amount * 10 ** (exp - cur.exponent) + balance * 10 ** (exp - line.exponent);
      if (!Number.isSafeInteger(scaled)) throw new LedgerError("too_large", { currency: code });
      acc.set(code, { exponent: exp, amount: scaled });
    }
  }
  const byCurrency = [...acc.entries()].map(([code, v]) => ({ code, exponent: v.exponent, amount: v.amount })).filter((c) => c.amount !== 0);
  const maxExp = byCurrency.reduce((m, c) => Math.max(m, c.exponent), 0);
  const scaled = (c: { amount: number; exponent: number }) => c.amount * 10 ** (maxExp - c.exponent);
  byCurrency.sort((a, b) => scaled(b) - scaled(a) || a.code.localeCompare(b.code));
  return { byCurrency, incomplete };
}
