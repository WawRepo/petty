import type { SignedEntryV1 } from "@petty/crypto";

/** An opened entry together with the server's plaintext ordering columns. */
export interface LedgerEntry {
  /** Server-assigned, unique and increasing per line. The only ordering clock. */
  readonly seq: number;
  /** Server receive time, ISO 8601. Display only. */
  readonly received_at: string;
  readonly entry: SignedEntryV1;
}

export type LineKind = "money" | "countable" | "single";

/**
 * Optional per-line extras (PETTY-64), all shared by every member because they live in the document:
 * `icon` — a slug from the app's icon set; `tags` — free labels ("cash", "valuables"), normalised like
 * drawer tags; `counted` — false when the line is not cash and must stay out of every total
 * (gold coins, a laptop). Absent means counted.
 */
export interface LineExtras {
  readonly icon?: string;
  readonly tags?: readonly string[];
  readonly counted?: boolean;
}
export interface MoneyLine extends LineExtras {
  readonly id: string;
  readonly kind: "money";
  readonly name: string;
  /** Editable label. Trimmed and upper-cased. Never used to derive the exponent. */
  readonly currency: string;
  /** Fixed at creation. Never changes. */
  readonly exponent: number;
}
export interface CountableLine extends LineExtras {
  readonly id: string;
  readonly kind: "countable";
  readonly name: string;
  readonly unit: string;
}
export interface SingleLine extends LineExtras {
  readonly id: string;
  readonly kind: "single";
  readonly name: string;
  readonly text: string;
}
export type Line = MoneyLine | CountableLine | SingleLine;

export interface VerificationLine {
  readonly line_id: string;
  readonly kind: LineKind;
  /** money / countable: the folded balance at that moment */
  readonly balance: number | null;
  /** single: ticked present or not */
  readonly present: boolean | null;
  /** money / countable: head seq of the entry log at that moment */
  readonly head_seq: number | null;
}
export interface Verification {
  readonly id: string;
  readonly author_id: string;
  /** Client clock, ISO 8601, display only. Staleness uses the drawer row's server timestamps (SPEC-ISSUES B3). */
  readonly logged_at: string;
  readonly comment: string;
  readonly lines: readonly VerificationLine[];
}

/** The drawer document, format v1. Sealed as one blob (see @petty/crypto sealDocument). */
export interface DrawerDocument {
  readonly v: 1;
  readonly name: string;
  readonly has_photo: boolean;
  /** Icon slug from the app's set (PETTY-64). Absent: the default drawer icon. */
  readonly icon?: string;
  readonly lines: readonly Line[];
  readonly verifications: readonly Verification[];
  /** Places or groups this drawer belongs to (PETTY-52): "basement", "shed". Optional so v1 documents written before it still parse; older builds ignore it. */
  readonly tags?: readonly string[];
}
