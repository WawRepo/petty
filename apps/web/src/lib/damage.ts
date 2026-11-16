import type { AnyRole } from "@petty/protocol";
import type { DrawerError } from "./drawers.js";

/**
 * PETTY-504: the ways out of a damaged drawer that can help, by reason. "Earlier versions" puts back an older
 * drawer document; it helps only where the document is at fault (or an older one was served), never where the
 * entries are: putting back a document leaves every entry as it is. Where nothing in this app can fix the drawer,
 * the hint says who or what can. Members, and Delete (owner) or Leave (the others), are always offered.
 */
export type DamageHint = "countElsewhere" | "askWriter" | "askOperator";
export interface DamageWays {
  /** the owner may put back an earlier version of the drawer's document */
  readonly restore: boolean;
  /** what to do where this app has no button for it */
  readonly hint: DamageHint | null;
  /** a link to the page that sets up the command line and the AI add-on, which can count an item again */
  readonly tools: boolean;
}

/** The document is at fault, or the server sent an older one: an earlier version can be put back over it. */
const DOCUMENT_REASONS: ReadonlySet<DrawerError> = new Set<DrawerError>(["bad_document", "decrypt_failed", "doc_rolled_back"]);

/**
 * `hasKey`: whether this device opened the drawer key; an earlier version is opened with it. A reason of
 * `unknown_schema` (saved by a newer Petty) is no damage to undo, and a key or sender problem is solved in
 * Members, not by an older document.
 */
export function damageWays(reason: DrawerError, role: AnyRole | undefined, hasKey: boolean): DamageWays {
  const writer = role === "owner" || role === "write";
  switch (reason) {
    // the entries add up past what can be counted exactly: a count starts the item's sum over, and the command
    // line and the AI add-on can count an item that this app cannot open (docs/cli.md)
    case "sum_too_large":
      return { restore: false, hint: writer ? "countElsewhere" : "askWriter", tools: writer };
    // rows out of order or repeated come from the server: nobody can fix them from a device
    case "bad_entries":
      return { restore: false, hint: "askOperator", tools: false };
    default:
      return { restore: role === "owner" && hasKey && DOCUMENT_REASONS.has(reason), hint: null, tools: false };
  }
}
