import { describe, expect, it } from "vitest";
import { applyOp, assertCurrencyCode, assertDocumentShape, newDocument, type DrawerDocument, type Line } from "../src/index.js";

/**
 * PETTY-414: an item's id and a currency code are printed by the command line and the AI add-on, so
 * both are checked as they are written. What a document already holds is still read as it is.
 */
const ctx = { lineHasEntries: () => false };
const ID = "00000000-0000-4000-8000-00000000000a";
const single = (id: string): Line => ({ id, kind: "single", name: "Passport", text: "" });

describe("a new item's id is a UUID", () => {
  it("add_line takes a UUID and refuses any other id", () => {
    expect(applyOp(newDocument("K"), { type: "add_line", line: single(ID) }, ctx).lines[0]!.id).toBe(ID);
    expect(applyOp(newDocument("K"), { type: "add_line", line: single(ID.toUpperCase()) }, ctx).lines).toHaveLength(1);
    for (const id of ["m1", "", `${ID}\nnext line`, ` ${ID}`, `${ID}/x`, ID.replace("4", "g")]) {
      expect(() => applyOp(newDocument("K"), { type: "add_line", line: single(id) }, ctx)).toThrow(/bad_line_id/);
    }
    expect(() => applyOp(newDocument("K"), { type: "add_line", line: { ...single(ID), id: 7 as unknown as string } }, ctx)).toThrow(/bad_line_id/);
  });

  it("a document that already holds another id is still read and still changed", () => {
    const old: DrawerDocument = { ...newDocument("K"), lines: [single("m1"), { id: "line 2", kind: "money", name: "Cash", currency: "PLN", exponent: 2 }] };
    expect(() => assertDocumentShape(JSON.parse(JSON.stringify(old)))).not.toThrow();
    const renamed = applyOp(old, { type: "rename_line", line_id: "m1", name: "ID card" }, ctx);
    expect(renamed.lines[0]).toMatchObject({ id: "m1", name: "ID card" });
    expect(applyOp(old, { type: "set_line_tags", line_id: "line 2", tags: ["cash"] }, ctx).lines[1]).toMatchObject({ id: "line 2", tags: ["cash"] });
    // and a new item goes in beside them
    expect(applyOp(old, { type: "add_line", line: single(ID) }, ctx).lines.map((l) => l.id)).toEqual(["m1", "line 2", ID]);
  });
});

describe("a currency code holds no control characters", () => {
  it("drops them as the code is written, and still refuses white space", () => {
    expect(assertCurrencyCode("pln")).toBe("PLN");
    expect(assertCurrencyCode("\u001b[2JPLN")).toBe("[2JPLN");
    expect(assertCurrencyCode("E\u0000U\u007fR\u009b")).toBe("EUR");
    const doc = applyOp(newDocument("K"), { type: "add_line", line: { id: ID, kind: "money", name: "Cash", currency: "us\u0007d", exponent: 2 } }, ctx);
    expect(doc.lines[0]).toMatchObject({ currency: "USD" });
    expect(applyOp(doc, { type: "set_currency", line_id: ID, currency: "\u0001chf" }, ctx).lines[0]).toMatchObject({ currency: "CHF", exponent: 2 });
    for (const code of ["", "   ", "PL N", "PL\nN", "PL\tN", "\u001b", "\u0000\u009f", "ABCDEFGHIJKLM"]) {
      expect(() => assertCurrencyCode(code)).toThrow(/bad_currency_code/);
    }
  });

  it("a document that already holds one in a code is still read", () => {
    const old = { ...newDocument("K"), lines: [{ id: ID, kind: "money", name: "Cash", currency: "PLN\u001b[31m", exponent: 2 }] };
    expect(() => assertDocumentShape(JSON.parse(JSON.stringify(old)))).not.toThrow();
  });
});
