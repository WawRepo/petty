import type { EntryOp } from "@petty/crypto";
import { LedgerError } from "./errors.js";
import type { FoldResult } from "./fold.js";
import type { LedgerEntry, Line, LineKind } from "./types.js";

/**
 * Signed amount for a new entry from the magnitude the user typed.
 * add → +m (m > 0); withdraw → −m (m > 0); adjust → m (m ≥ 0, the counted value).
 * Reverse amounts come from `reverseOf`, never from input.
 */
export function newEntryAmount(op: Exclude<EntryOp, "reverse">, magnitude: number): number {
  if (!Number.isSafeInteger(magnitude)) throw new LedgerError("amount_not_integer");
  if (op === "adjust") {
    if (magnitude < 0) throw new LedgerError("adjust_negative");
    return magnitude;
  }
  if (magnitude <= 0) throw new LedgerError("amount_not_positive");
  return op === "add" ? magnitude : -magnitude;
}

export type ReverseRefusal = "adjust_not_reversible" | "reverse_not_reversible" | "already_reversed" | "before_checkpoint";

/** What a Reverse of `target` must look like, or why it is refused (spec "Correcting a mistake"). */
export function reverseOf(target: LedgerEntry, current: FoldResult): { ok: true; amount: number; reverses: string } | { ok: false; code: ReverseRefusal } {
  if (target.entry.op === "adjust") return { ok: false, code: "adjust_not_reversible" };
  if (target.entry.op === "reverse") return { ok: false, code: "reverse_not_reversible" };
  if (current.checkpoint && target.seq <= current.checkpoint.seq) return { ok: false, code: "before_checkpoint" };
  if (current.reversed.has(target.entry.id)) return { ok: false, code: "already_reversed" };
  return { ok: true, amount: -target.entry.amount, reverses: target.entry.id };
}

/** The balance a withdraw would leave, for the "this takes the balance to −60" warning. Null when no warning is needed. */
export function negativeWarning(balance: number, signedAmount: number): number | null {
  const next = balance + signedAmount;
  return next < 0 ? next : null;
}

/** Kind is editable only while the line has no entries. Single items never have entries. */
export function canChangeKind(line: Line, hasEntries: boolean): boolean {
  return line.kind === "single" ? true : !hasEntries;
}

export function kindHasEntries(kind: LineKind): boolean {
  return kind !== "single";
}

/** Currency codes are labels; normalise so "eur" and "EUR" are one total. */
export function normalizeCurrencyCode(code: string): string {
  return code.trim().toUpperCase();
}

export const MAX_CURRENCY_CODE_LENGTH = 12;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this drops
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * White space inside a code is refused. Other control characters are dropped (PETTY-414): the code is
 * a label that the command line and the AI add-on print next to every amount.
 */
export function assertCurrencyCode(code: string): string {
  const c = normalizeCurrencyCode(code);
  if (/\s/.test(c)) throw new LedgerError("bad_currency_code");
  const plain = c.replace(CONTROL, "");
  if (plain.length === 0 || plain.length > MAX_CURRENCY_CODE_LENGTH) throw new LedgerError("bad_currency_code");
  return plain;
}
