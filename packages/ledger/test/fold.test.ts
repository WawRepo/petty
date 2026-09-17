import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LedgerError, fold, newEntryAmount, reverseOf, negativeWarning } from "../src/index.js";
import { fake } from "./helpers.js";

describe("fold", () => {
  it("empty log is zero, not negative, no checkpoint", () => {
    const r = fold([]);
    expect(r).toMatchObject({ balance: 0, checkpoint: null, negative: false, headSeq: null });
  });

  it("sums add and withdraw; order of concurrent adds does not matter", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 30 }), fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 30 }), (adds, withdraws) => {
        const ops: Array<["add" | "withdraw", number]> = [...adds.map((a) => ["add", a] as ["add", number]), ...withdraws.map((w) => ["withdraw", -w] as ["withdraw", number])];
        const expected = adds.reduce((s, a) => s + a, 0) - withdraws.reduce((s, w) => s + w, 0);
        const forward = ops.map(([op, amt], i) => fake(i + 1, op, amt));
        const shuffledSeqs = [...forward].reverse().map((e, i) => ({ ...e, seq: i + 1, entry: { ...e.entry, id: `r${i}` } }));
        expect(fold(forward).balance).toBe(expected);
        expect(fold(shuffledSeqs).balance).toBe(expected);
        expect(fold(forward).negative).toBe(expected < 0);
      }),
    );
  });

  it("Adjust is an absolute checkpoint; everything before it is ignored", () => {
    const r = fold([fake(1, "add", 10000), fake(2, "withdraw", -300), fake(3, "adjust", 5000, { delta_hint: -4700 }), fake(4, "add", 100)]);
    expect(r.balance).toBe(5100);
    expect(r.checkpoint?.seq).toBe(3);
    expect(r.applied.map((e) => e.seq)).toEqual([4]);
    // an earlier adjust is also ignored
    const r2 = fold([fake(1, "adjust", 1), fake(2, "add", 1), fake(3, "adjust", 7), fake(4, "add", 1)]);
    expect(r2.balance).toBe(8);
  });

  it("SPEC-ISSUES A4: a Reverse of an entry older than the last Adjust is not applied (folds to 50, not 550)", () => {
    const log = [
      fake(1, "add", 10000),                              // 100.00
      fake(2, "withdraw", -50000, { id: "typo" }),        // −500 by mistake
      fake(3, "adjust", 5000),                            // counted 50.00
      fake(4, "reverse", 50000, { reverses: "typo" }),    // landed anyway (offline / race)
    ];
    const r = fold(log);
    expect(r.balance).toBe(5000);
    expect(r.skipped).toEqual([{ entry: log[3], code: "reverse_target_missing" }]);
    expect(reverseOf(log[1]!, r)).toEqual({ ok: false, code: "before_checkpoint" });
  });

  it("a valid Reverse cancels arithmetically and the target stays in history", () => {
    const log = [fake(1, "withdraw", -50000, { id: "typo" }), fake(2, "reverse", 50000, { reverses: "typo" }), fake(3, "withdraw", -5000)];
    const r = fold(log);
    expect(r.balance).toBe(-5000);
    expect(r.reversed.has("typo")).toBe(true);
    expect(r.reversedBy.get("typo")).toBe("f2");
    expect(r.applied.length).toBe(3);
    expect(r.negative).toBe(true);
  });

  it("refuses: reversing a Reverse, reversing an Adjust, reversing twice, wrong amount", () => {
    const log = [
      fake(1, "add", 100, { id: "a" }),
      fake(2, "reverse", -100, { id: "ra", reverses: "a" }),
      fake(3, "reverse", 100, { reverses: "ra" }),          // reverse of a reverse
      fake(4, "reverse", -100, { reverses: "a" }),          // duplicate
      fake(5, "add", 7, { id: "b" }),
      fake(6, "reverse", -8, { reverses: "b" }),            // amount mismatch
      fake(7, "adjust", 50, { id: "adj" }),
      fake(8, "reverse", -50, { reverses: "adj" }),         // adjust target: not in window anyway
    ];
    const r = fold(log);
    expect(r.balance).toBe(50);
    expect(r.skipped.map((s) => s.code)).toEqual(["reverse_target_missing"]);
    const before = fold(log.slice(0, 6));
    expect(before.skipped.map((s) => s.code)).toEqual(["reverse_target_not_reversible", "reverse_duplicate", "reverse_amount_mismatch"]);
    expect(reverseOf(log[1]!, before)).toEqual({ ok: false, code: "reverse_not_reversible" });
    expect(reverseOf(log[0]!, before)).toEqual({ ok: false, code: "already_reversed" });
    expect(reverseOf(log[4]!, before)).toEqual({ ok: true, amount: -7, reverses: "b" });
    expect(reverseOf(log[6]!, r)).toEqual({ ok: false, code: "adjust_not_reversible" });
  });

  it("rejects duplicate seqs and mixed lines", () => {
    expect(() => fold([fake(1, "add", 1), fake(1, "add", 1, { id: "x" })])).toThrow(LedgerError);
    expect(() => fold([fake(1, "add", 1), fake(2, "add", 1, { line_id: "other" })])).toThrow(LedgerError);
  });
});

describe("rules", () => {
  it("newEntryAmount signs by operation and validates", () => {
    expect(newEntryAmount("add", 5)).toBe(5);
    expect(newEntryAmount("withdraw", 5)).toBe(-5);
    expect(newEntryAmount("adjust", 0)).toBe(0);
    expect(() => newEntryAmount("add", 0)).toThrow(LedgerError);
    expect(() => newEntryAmount("withdraw", -1)).toThrow(LedgerError);
    expect(() => newEntryAmount("adjust", -1)).toThrow(LedgerError);
    expect(() => newEntryAmount("add", 1.5)).toThrow(LedgerError);
  });
  it("negativeWarning reports the resulting balance only when below zero", () => {
    expect(negativeWarning(34000, -40000)).toBe(-6000);
    expect(negativeWarning(34000, -34000)).toBeNull();
    expect(negativeWarning(-100, 50)).toBe(-50);
  });
});
