import { describe, expect, it } from "vitest";
import { damageWays } from "./damage.js";
import type { DrawerError } from "./drawers.js";

const ALL: readonly DrawerError[] = [
  "no_key", "sender_unknown", "sender_unconfirmed", "sender_left", "sender_gone", "sender_key_changed", "pins_blocked", "key_replaced", "key_rolled_back",
  "doc_rolled_back", "unwrap_failed", "decrypt_failed", "bad_document", "unknown_schema", "bad_entries", "sum_too_large",
];

// PETTY-504: a damaged drawer offers only the ways out that can help with its reason
describe("damageWays", () => {
  it("offers the owner an earlier version only where the document is at fault, and only with the drawer key", () => {
    const restorable = ALL.filter((r) => damageWays(r, "owner", true).restore);
    expect(restorable).toEqual(["doc_rolled_back", "decrypt_failed", "bad_document"]);
    for (const r of ALL) expect(damageWays(r, "owner", false).restore).toBe(false);
    for (const role of ["write", "read", undefined] as const) for (const r of ALL) expect(damageWays(r, role, true).restore).toBe(false);
  });

  it("never offers an earlier version for entries that are at fault: putting back a document leaves them as they are", () => {
    for (const role of ["owner", "write", "read"] as const) {
      expect(damageWays("bad_entries", role, true)).toEqual({ restore: false, hint: "askOperator", tools: false });
      expect(damageWays("sum_too_large", role, true).restore).toBe(false);
    }
  });

  it("sends a writer to the command line or the AI add-on to count the item again, and a reader to a writer", () => {
    expect(damageWays("sum_too_large", "owner", true)).toEqual({ restore: false, hint: "countElsewhere", tools: true });
    expect(damageWays("sum_too_large", "write", true)).toEqual({ restore: false, hint: "countElsewhere", tools: true });
    expect(damageWays("sum_too_large", "read", true)).toEqual({ restore: false, hint: "askWriter", tools: false });
  });

  it("adds no hint where the reason text already says what to do", () => {
    for (const r of ALL.filter((x) => x !== "bad_entries" && x !== "sum_too_large")) {
      expect(damageWays(r, "owner", true).hint).toBeNull();
      expect(damageWays(r, "owner", true).tools).toBe(false);
    }
  });
});
