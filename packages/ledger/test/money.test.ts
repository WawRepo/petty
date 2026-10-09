import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LedgerError, decimalSeparator, formatAmount, formatCount, formatMoney, isIsoCurrency, parseAmount, seedExponent } from "../src/index.js";

describe("exponent seeding", () => {
  it("ISO codes seed their exponent; unknown codes get 2; case and spaces are ignored", () => {
    expect(seedExponent("EUR")).toBe(2);
    expect(seedExponent("pln")).toBe(2);
    expect(seedExponent("JPY")).toBe(0);
    expect(seedExponent(" kwd ")).toBe(3);
    expect(seedExponent("BTC")).toBe(2);
    expect(seedExponent("chips")).toBe(2);
    expect(isIsoCurrency("usd")).toBe(true);
    expect(isIsoCurrency("BTC")).toBe(false);
  });
});

describe("parseAmount", () => {
  it("accepts comma and dot as the decimal mark, and grouping spaces", () => {
    expect(parseAmount("1 234,56", 2)).toBe(123456);
    expect(parseAmount("1234.56", 2)).toBe(123456);
    expect(parseAmount("1,234.56", 2)).toBe(123456);
    expect(parseAmount("1.234,56", 2)).toBe(123456);
    expect(parseAmount("1 234,5", 2)).toBe(123450);
    expect(parseAmount("0,5", 2)).toBe(50);
    expect(parseAmount(",5", 2)).toBe(50);
    expect(parseAmount("12", 2)).toBe(1200);
    expect(parseAmount("1.234.567", 2)).toBe(123456700); // repeated mark = grouping
  });
  it("JPY: whole units only", () => {
    expect(parseAmount("1000", 0)).toBe(1000);
    expect(parseAmount("1 000", 0)).toBe(1000);
    expect(() => parseAmount("1.5", 0)).toThrow(LedgerError);
  });
  it("rejects too many decimals, signs, letters, empties", () => {
    expect(() => parseAmount("1.234", 2)).toThrow(/too_many_decimals/);
    expect(() => parseAmount("-5", 2)).toThrow(/invalid/);
    expect(() => parseAmount("5 PLN", 2)).toThrow(/invalid/);
    expect(() => parseAmount("", 2)).toThrow(/empty/);
    expect(() => parseAmount(".", 2)).toThrow(/invalid/);
    expect(() => parseAmount("1,2,3.4", 2)).toThrow(/invalid/);
    expect(() => parseAmount("12.3456.7", 2)).toThrow(/invalid/);
    expect(() => parseAmount("1,234", 2)).toThrow(/too_many_decimals/); // one mark, once → decimal mark → 3 decimals
    expect(parseAmount("1,234", 3)).toBe(1234);
    // PETTY-351: a whole number has no decimals, so one mark before three digits groups thousands
    expect(parseAmount("1,000", 0)).toBe(1000);
    expect(parseAmount("1.000", 0)).toBe(1000);
    expect(parseAmount("12,345", 0)).toBe(12345);
    expect(() => parseAmount("1,5", 0)).toThrow(/too_many_decimals/);
    expect(() => parseAmount("1,0000", 0)).toThrow(/too_many_decimals/);
    expect(() => parseAmount("1234,567", 0)).toThrow(/too_many_decimals/);

    expect(() => parseAmount("99999999999999999", 2)).toThrow(/too_large/);
  });
  it("format then parse is the identity for any integer and exponent, in en and pl", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_007_199_254 }), fc.integer({ min: 0, max: 4 }), fc.constantFrom("en", "pl", "de", "fr", "es"), (n, exp, locale) => {
        expect(parseAmount(formatAmount(n, exp, locale), exp)).toBe(n);
      }),
      { numRuns: 2000 },
    );
    // PETTY-351: the case CI found (seed 2087973570), kept as a fixed example
    expect(parseAmount(formatAmount(1000, 0, "en"), 0)).toBe(1000);
  });
});

describe("formatting", () => {
  it("is exact and locale-aware", () => {
    expect(formatAmount(123456, 2, "pl")).toBe("1\u00a0234,56");
    expect(formatAmount(123456, 2, "en")).toBe("1,234.56");
    expect(formatAmount(1000, 0, "en")).toBe("1,000");
    expect(formatAmount(5, 2, "en")).toBe("0.05");
    expect(formatAmount(-6000, 2, "en")).toBe("−60.00");
    expect(formatMoney(234000, 2, "pln", "pl")).toBe("2\u00a0340,00 PLN");
    expect(formatCount(56, "en")).toBe("56");
    expect(decimalSeparator("pl")).toBe(",");
    expect(decimalSeparator("en")).toBe(".");
  });
  it("never rescales: the same integer at different exponents prints differently", () => {
    expect(formatAmount(1000, 2, "en")).toBe("10.00");
    expect(formatAmount(1000, 0, "en")).toBe("1,000");
  });
});
