import { describe, expect, it } from "vitest";
import { LedgerError, applyOp, applyOps, assertDocumentShape, foldText, hasTag, iconOf, lineCounted, lineTagsOf, newDocument, staleness, tagsOf, totals, type Line, type Verification, colorOf } from "../src/index.js";

const money = (id: string, currency = "PLN", exponent = 2): Line => ({ id, kind: "money", name: `${currency} ${id}`, currency, exponent });
const single = (id: string): Line => ({ id, kind: "single", name: "Passport", text: "" });
const ctx = (withEntries: string[] = []) => ({ lineHasEntries: (id: string) => withEntries.includes(id) });

describe("document ops", () => {
  it("builds a document by applying operations without mutating the input", () => {
    const d0 = newDocument("Kitchen");
    const d1 = applyOps(d0, [{ type: "add_line", line: money("a") }, { type: "add_line", line: money("b", "eur") }, { type: "add_line", line: single("c") }], ctx());
    expect(d0.lines.length).toBe(0);
    expect(d1.lines.map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect((d1.lines[1] as { currency: string }).currency).toBe("EUR");
  });

  it("move_up / move_down / move_line / reorder work by keyboard semantics", () => {
    const d = applyOps(newDocument("K"), ["a", "b", "c"].map((id) => ({ type: "add_line" as const, line: money(id) })), ctx());
    expect(applyOp(d, { type: "move_up", line_id: "c" }, ctx()).lines.map((l) => l.id)).toEqual(["a", "c", "b"]);
    expect(applyOp(d, { type: "move_up", line_id: "a" }, ctx()).lines.map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect(applyOp(d, { type: "move_down", line_id: "a" }, ctx()).lines.map((l) => l.id)).toEqual(["b", "a", "c"]);
    expect(applyOp(d, { type: "move_line", line_id: "a", to: 99 }, ctx()).lines.map((l) => l.id)).toEqual(["b", "c", "a"]);
    expect(applyOp(d, { type: "reorder", ids: ["c", "a", "b"] }, ctx()).lines.map((l) => l.id)).toEqual(["c", "a", "b"]);
    expect(() => applyOp(d, { type: "reorder", ids: ["c", "a"] }, ctx())).toThrow(LedgerError);
  });

  it("currency relabel keeps the exponent; kind locks once the line has entries", () => {
    const d = applyOp(newDocument("K"), { type: "add_line", line: money("a", "USD", 2) }, ctx());
    const relabelled = applyOp(d, { type: "set_currency", line_id: "a", currency: "jpy" }, ctx());
    expect(relabelled.lines[0]).toMatchObject({ currency: "JPY", exponent: 2 });
    const toCountable: Line = { id: "a", kind: "countable", name: "Balls", unit: "balls" };
    expect(applyOp(d, { type: "change_kind", line_id: "a", line: toCountable }, ctx()).lines[0]?.kind).toBe("countable");
    expect(() => applyOp(d, { type: "change_kind", line_id: "a", line: toCountable }, ctx(["a"]))).toThrow(/kind_locked/);
  });

  it("ops that no longer apply after a concurrent change throw a coded error (offline replay)", () => {
    const d = applyOp(newDocument("K"), { type: "add_line", line: money("a") }, ctx());
    const someoneRemovedIt = applyOp(d, { type: "remove_line", line_id: "a" }, ctx());
    expect(() => applyOp(someoneRemovedIt, { type: "rename_line", line_id: "a", name: "x" }, ctx())).toThrow(/line_not_found/);
    expect(() => applyOp(d, { type: "add_line", line: money("a") }, ctx())).toThrow(/line_exists/);
    expect(() => applyOp(d, { type: "set_unit", line_id: "a", unit: "x" }, ctx())).toThrow(/not_countable_line/);
    expect(() => applyOp(d, { type: "rename_drawer", name: "   " }, ctx())).toThrow(/bad_name/);
  });

  it("assertDocumentShape rejects junk and duplicate line ids", () => {
    const good = applyOp(newDocument("K"), { type: "add_line", line: money("a") }, ctx());
    expect(() => assertDocumentShape(good)).not.toThrow();
    expect(() => assertDocumentShape({ ...good, lines: [money("a"), money("a")] })).toThrow(/bad_document/);
    expect(() => assertDocumentShape({ v: 2 })).toThrow(/bad_document/);
    expect(() => assertDocumentShape({ ...good, lines: [{ id: "z", kind: "money", name: "x", currency: "EUR", exponent: 99 }] })).toThrow(/bad_exponent/);
  });
});

describe("staleness (server clock only)", () => {
  const v = (id: string, t: string): Verification => ({ id, author_id: "u", logged_at: t, comment: "", lines: [] });
  const T0 = "2026-08-28T12:00:00Z", T1 = "2026-08-28T12:00:01Z";
  it("never / verified / stale", () => {
    const d0 = newDocument("K");
    expect(staleness(d0, { last_write_at: T0, last_verified_at: null }).status).toBe("never");
    const d1 = applyOp(d0, { type: "append_verification", verification: v("v1", "whatever-client-clock") }, ctx());
    expect(staleness(d1, { last_write_at: T0, last_verified_at: T0 }).status).toBe("verified"); // the verification's own write
    expect(staleness(d1, { last_write_at: T1, last_verified_at: T0 }).status).toBe("stale");    // any later write, of any kind
    const d2 = applyOp(d1, { type: "append_verification", verification: v("v2", "x") }, ctx());
    expect(staleness(d2, { last_write_at: T1, last_verified_at: T1 })).toMatchObject({ status: "verified", last: { id: "v2" } });
  });
});

describe("tags (PETTY-52)", () => {
  it("normalises: trims, collapses spaces, cuts to 24, de-duplicates by fold, keeps the first spelling, caps at 5", () => {
    const d = applyOp(newDocument("K"), { type: "set_tags", tags: ["  Basement ", "basement", "BASEMENT", "Szopa   ogrodowa", "szopa ogrodowa", "", "car", "attic", "x".repeat(40), "six"] }, ctx());
    expect(d.tags).toEqual(["Basement", "Szopa ogrodowa", "car", "attic", "x".repeat(24)]);
    expect(hasTag(d, "basement")).toBe(true);
    expect(hasTag(d, "szopa ogrodowa")).toBe(true);
    expect(foldText("Łódź")).toBe("łodz".normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  });
  it("an empty list removes the field, so documents without tags stay byte-identical to before", () => {
    const d = applyOp(applyOp(newDocument("K"), { type: "set_tags", tags: ["a"] }, ctx()), { type: "set_tags", tags: [] }, ctx());
    expect("tags" in d).toBe(false);
    expect(tagsOf(d)).toEqual([]);
    expect(() => assertDocumentShape(d)).not.toThrow();
  });
  it("shape check accepts a v1 document with or without tags and rejects bad ones", () => {
    const base = newDocument("K");
    expect(() => assertDocumentShape({ ...base, tags: ["shed"] })).not.toThrow();
    expect(() => assertDocumentShape({ ...base, tags: [""] })).toThrow(LedgerError);
    expect(() => assertDocumentShape({ ...base, tags: "shed" })).toThrow(LedgerError);
    expect(() => assertDocumentShape({ ...base, tags: ["1", "2", "3", "4", "5", "6"] })).toThrow(LedgerError);
  });
});

describe("totals", () => {
  const ml = (currency: string, exponent: number, balance: number) => ({ line: { id: currency + balance, kind: "money" as const, name: "", currency, exponent }, balance });
  it("groups by upper-cased code, excludes countables by type, marks incomplete", () => {
    const t = totals([
      { ok: true, moneyLines: [ml("PLN", 2, 200000), ml("eur", 2, 61500)] },
      { ok: true, moneyLines: [ml("pln", 2, 34000), ml("USD", 2, 20000)] },
      { ok: false, moneyLines: [] },
    ]);
    expect(t.incomplete).toBe(true);
    // largest first, so the home screen reads "the big pile" at the top
    expect(t.byCurrency).toEqual([
      { code: "PLN", exponent: 2, amount: 234000 },
      { code: "EUR", exponent: 2, amount: 61500 },
      { code: "USD", exponent: 2, amount: 20000 },
    ]);
  });
  it("orders by value at a common exponent, drops zero totals, keeps negatives, ties by code", () => {
    const t = totals([{ ok: true, moneyLines: [ml("JPY", 0, 1500), ml("EUR", 2, 100000), ml("PLN", 2, 0), ml("GBP", 2, -500), ml("USD", 2, 100000)] }]);
    expect(t.byCurrency.map((c) => `${c.code}:${c.amount}`)).toEqual(["JPY:1500", "EUR:100000", "USD:100000", "GBP:-500"]);
  });
  it("sums lines with the same code but different exponents exactly at the larger exponent", () => {
    const t = totals([{ ok: true, moneyLines: [ml("JPY", 0, 1000), ml("JPY", 2, 50)] }]);
    expect(t.byCurrency).toEqual([{ code: "JPY", exponent: 2, amount: 100050 }]);
  });
});

describe("line extras and drawer icon (PETTY-64)", () => {
  const money = { id: "m1", kind: "money" as const, name: "Cash", currency: "PLN", exponent: 2 };
  const base = () => applyOp(newDocument("K"), { type: "add_line", line: money }, ctx());
  it("a line keeps its icon, tags and counted flag through validation; defaults are dropped", () => {
    const d = applyOp(newDocument("K"), { type: "add_line", line: { ...money, icon: "banknote", tags: [" Cash ", "cash", "Valuables"], counted: true } }, ctx());
    expect(d.lines[0]).toEqual({ ...money, icon: "banknote", tags: ["Cash", "Valuables"] });
    expect(lineCounted(d.lines[0]!)).toBe(true);
    expect(lineTagsOf(d.lines[0]!)).toEqual(["Cash", "Valuables"]);
  });
  it("set_line_counted false marks the line; true removes the flag", () => {
    const off = applyOp(base(), { type: "set_line_counted", line_id: "m1", counted: false }, ctx());
    expect(off.lines[0]!.counted).toBe(false);
    expect(lineCounted(off.lines[0]!)).toBe(false);
    const on = applyOp(off, { type: "set_line_counted", line_id: "m1", counted: true }, ctx());
    expect("counted" in on.lines[0]!).toBe(false);
  });
  it("set_line_tags normalises like drawer tags; empty clears", () => {
    const d = applyOp(base(), { type: "set_line_tags", line_id: "m1", tags: ["electronics", " ELECTRONICS", "home"] }, ctx());
    expect(d.lines[0]!.tags).toEqual(["electronics", "home"]);
    expect("tags" in applyOp(d, { type: "set_line_tags", line_id: "m1", tags: [] }, ctx()).lines[0]!).toBe(false);
  });
  it("icons are short slugs; null clears", () => {
    const d = applyOp(applyOp(base(), { type: "set_line_icon", line_id: "m1", icon: "gem" }, ctx()), { type: "set_icon", icon: "home" }, ctx());
    expect(d.lines[0]!.icon).toBe("gem");
    expect(iconOf(d)).toBe("home");
    expect(() => applyOp(d, { type: "set_line_icon", line_id: "m1", icon: "Not a slug!" }, ctx())).toThrow(LedgerError);
    expect(() => applyOp(d, { type: "set_icon", icon: "" }, ctx())).toThrow(LedgerError);
    const cleared = applyOp(applyOp(d, { type: "set_line_icon", line_id: "m1", icon: null }, ctx()), { type: "set_icon", icon: null }, ctx());
    expect("icon" in cleared.lines[0]!).toBe(false);
    expect(iconOf(cleared)).toBeNull();
  });
  it("a drawer colour is a short slug; null goes back to the default (PETTY-252)", () => {
    const d = applyOp(base(), { type: "set_color", color: "teal" }, ctx());
    expect(colorOf(d)).toBe("teal");
    expect(colorOf(base())).toBeNull();
    expect(() => applyOp(d, { type: "set_color", color: "#ff0000" }, ctx())).toThrow(LedgerError);
    expect(() => applyOp(d, { type: "set_color", color: "" }, ctx())).toThrow(LedgerError);
    const cleared = applyOp(d, { type: "set_color", color: null }, ctx());
    expect("color" in cleared).toBe(false);
    // other changes keep it, as an older build's would (they spread the document)
    expect(colorOf(applyOp(d, { type: "set_icon", icon: "home" }, ctx()))).toBe("teal");
    expect(() => assertDocumentShape(JSON.parse(JSON.stringify(d)))).not.toThrow();
    expect(() => assertDocumentShape({ ...d, color: 7 })).toThrow(LedgerError);
    expect(() => assertDocumentShape({ ...d, color: "Not a slug!" })).toThrow(LedgerError);
  });
  it("assertDocumentShape accepts the new fields and rejects a bad icon", () => {
    const d = applyOp(applyOp(base(), { type: "set_line_tags", line_id: "m1", tags: ["cash"] }, ctx()), { type: "set_icon", icon: "home" }, ctx());
    expect(() => assertDocumentShape(JSON.parse(JSON.stringify(d)))).not.toThrow();
    expect(() => assertDocumentShape({ ...d, icon: 5 })).toThrow(LedgerError);
    expect(() => assertDocumentShape({ ...d, lines: [{ ...money, counted: "no" }] })).toThrow(LedgerError);
  });
});
