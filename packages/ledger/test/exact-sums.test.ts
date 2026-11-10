import { describe, expect, it } from "vitest";
import { assertDocumentShape, fold, sumsAreExact, totals } from "../src/index.js";
import { fake } from "./helpers.js";

/**
 * PETTY-443: amounts are integers in minor units, and a sum of them is exact or it is not shown. One
 * entry can hold the largest exact integer, so what is added up from a ledger is checked, never assumed.
 */
const max = Number.MAX_SAFE_INTEGER;
const ml = (currency: string, exponent: number, balance: number) => ({ line: { id: crypto.randomUUID(), kind: "money" as const, name: "", currency, exponent }, balance });

describe("fold: a sum that leaves the exact integers", () => {
  it("is marked, upwards and downwards", () => {
    expect(fold([])).toMatchObject({ balance: 0, overflow: false });
    expect(fold([fake(1, "add", max)])).toMatchObject({ balance: max, overflow: false });
    expect(fold([fake(1, "add", max), fake(2, "add", max)]).overflow).toBe(true);
    expect(fold([fake(1, "withdraw", -max), fake(2, "withdraw", -max)]).overflow).toBe(true);
  });
  it("stays marked when later entries bring it back into range: what was added past the range was rounded", () => {
    const back = fold([fake(1, "add", max), fake(2, "add", 3), fake(3, "add", 1), fake(4, "withdraw", -max)]);
    expect(Number.isSafeInteger(back.balance)).toBe(true);
    expect(back.overflow).toBe(true);
  });
  it("is marked when a Reverse takes it out of range", () => {
    expect(fold([fake(1, "add", max), fake(2, "withdraw", -max, { id: "w" }), fake(3, "add", max), fake(4, "reverse", max, { reverses: "w" })]).overflow).toBe(true);
  });
  it("starts over at a count", () => {
    expect(fold([fake(1, "add", max), fake(2, "add", max), fake(3, "adjust", 500), fake(4, "add", 1)])).toMatchObject({ balance: 501, overflow: false });
  });
});

describe("totals: a total that leaves the exact integers", () => {
  it("is left out and the result marked incomplete; the other currencies stay and nothing throws", () => {
    const t = totals([{ ok: true, moneyLines: [ml("EUR", 2, max), ml("PLN", 2, 500)] }, { ok: true, moneyLines: [ml("eur", 2, max), ml("EUR", 2, -max), ml("PLN", 2, 1)] }]);
    expect(t).toEqual({ byCurrency: [{ code: "PLN", exponent: 2, amount: 501 }], incomplete: true });
  });
  it("also when only the common exponent makes it too large, and for one balance that is not exact on its own", () => {
    expect(totals([{ ok: true, moneyLines: [ml("JPY", 0, 10 ** 15), ml("JPY", 8, 1)] }])).toEqual({ byCurrency: [], incomplete: true });
    expect(totals([{ ok: true, moneyLines: [ml("EUR", 2, 2 ** 60)] }])).toEqual({ byCurrency: [], incomplete: true });
  });
  it("the largest exact integer itself is a total like any other", () => {
    expect(totals([{ ok: true, moneyLines: [ml("EUR", 2, max)] }])).toEqual({ byCurrency: [{ code: "EUR", exponent: 2, amount: max }], incomplete: false });
  });
});

describe("sumsAreExact", () => {
  it("true while every sum of the lines of one currency fits, whatever the signs and the order", () => {
    expect(sumsAreExact([])).toBe(true);
    expect(sumsAreExact([ml("EUR", 2, max)])).toBe(true);
    expect(sumsAreExact([ml("EUR", 2, max), ml("PLN", 2, max), ml("USD", 2, -max)])).toBe(true);
    expect(sumsAreExact([ml("EUR", 2, max - 5), ml("eur", 2, 5)])).toBe(true);
    expect(sumsAreExact([ml("JPY", 0, 1000), ml("JPY", 2, 50)])).toBe(true);
  });
  it("false when a sum of some of them would not fit", () => {
    expect(sumsAreExact([ml("EUR", 2, max), ml(" eur", 2, 1)])).toBe(false);
    // the whole sums to the largest exact integer, but the first two alone do not fit
    expect(sumsAreExact([ml("EUR", 2, max), ml("EUR", 2, max), ml("EUR", 2, -max)])).toBe(false);
    expect(sumsAreExact([ml("EUR", 2, -max), ml("EUR", 2, -1)])).toBe(false);
    expect(sumsAreExact([ml("JPY", 0, 10 ** 15), ml("JPY", 8, 1)])).toBe(false);
    expect(sumsAreExact([ml("EUR", 2, 1.5)])).toBe(false);
    expect(sumsAreExact([ml("EUR", 2, 2 ** 60)])).toBe(false);
  });
});

describe("assertDocumentShape: the lines of a verification", () => {
  // what is stored there is formatted on screen
  const line = "7f2c1d0e-5b3a-4c8e-9d1f-0a2b3c4d5e6f";
  const item = "0b9e8d7c-6f5a-4e3d-8c2b-1a0f9e8d7c6b";
  const withLine = (vl: unknown) => ({ v: 1, name: "K", has_photo: false, lines: [], verifications: [{ id: crypto.randomUUID(), author_id: crypto.randomUUID(), logged_at: "2026-08-28T12:00:00Z", comment: "", lines: [vl] }] });

  it("accepts them as the app writes them, for a counted line and for a single item", () => {
    expect(() => assertDocumentShape(withLine({ line_id: line, kind: "money", balance: 10000, present: null, head_seq: 4 }))).not.toThrow();
    expect(() => assertDocumentShape(withLine({ line_id: line, kind: "countable", balance: -3, present: null, head_seq: 0 }))).not.toThrow();
    expect(() => assertDocumentShape(withLine({ line_id: item, kind: "single", balance: null, present: false, head_seq: null }))).not.toThrow();
  });
  it("reads a field that is left out as null", () => {
    expect(() => assertDocumentShape(withLine({ line_id: line, balance: 10000, head_seq: 4 }))).not.toThrow();
    expect(() => assertDocumentShape(withLine({ line_id: item, present: true }))).not.toThrow();
  });
  it("refuses a line that is no object, an unknown kind, and a balance, a head or a tick of the wrong type", () => {
    for (const bad of [
      null, "a", 7, {},
      { line_id: 7, kind: "money", balance: 1, present: null, head_seq: 1 },
      { line_id: line, kind: "gold", balance: 1, present: null, head_seq: 1 },
      { line_id: line, kind: "money", balance: 1.5, present: null, head_seq: 1 },
      { line_id: line, kind: "money", balance: "10000", present: null, head_seq: 1 },
      { line_id: line, kind: "money", balance: 2 ** 53, present: null, head_seq: 1 },
      { line_id: line, kind: "money", balance: Number.NaN, present: null, head_seq: 1 },
      { line_id: line, kind: "money", balance: {}, present: null, head_seq: 1 },
      { line_id: line, kind: "money", balance: 1, present: null, head_seq: 1.5 },
      { line_id: line, kind: "money", balance: 1, present: null, head_seq: "4" },
      { line_id: item, kind: "single", balance: null, present: "yes", head_seq: null },
    ]) expect(() => assertDocumentShape(withLine(bad)), JSON.stringify(bad)).toThrow(/bad_document/);
  });
});
