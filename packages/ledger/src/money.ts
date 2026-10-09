import { LedgerError } from "./errors.js";
import { normalizeCurrencyCode } from "./rules.js";

/**
 * ISO 4217 active codes and their minor-unit exponent. Used to SEED a line's
 * exponent at creation and to offer suggestions. Never consulted afterwards —
 * the exponent lives on the line (CLAUDE.md rule 5).
 */
const ZERO = "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF".split(" ");
const THREE = "BHD IQD JOD KWD LYD OMR TND".split(" ");
const FOUR = "CLF UYW".split(" ");
const TWO = `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CNY COP CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD UYU UZS VES WST XCD YER ZAR ZMW ZWG`.split(" ");

export interface CurrencyInfo { readonly code: string; readonly exponent: number }
export const ISO_4217: readonly CurrencyInfo[] = [
  ...ZERO.map((code) => ({ code, exponent: 0 })),
  ...TWO.map((code) => ({ code, exponent: 2 })),
  ...THREE.map((code) => ({ code, exponent: 3 })),
  ...FOUR.map((code) => ({ code, exponent: 4 })),
].sort((a, b) => a.code.localeCompare(b.code));
const BY_CODE = new Map(ISO_4217.map((c) => [c.code, c.exponent]));

export const DEFAULT_EXPONENT = 2;
export const MAX_EXPONENT = 8;

/** Exponent to pin on a NEW money line: the ISO one when the code is known, else 2. */
export function seedExponent(code: string): number {
  return BY_CODE.get(normalizeCurrencyCode(code)) ?? DEFAULT_EXPONENT;
}
export function isIsoCurrency(code: string): boolean {
  return BY_CODE.has(normalizeCurrencyCode(code));
}

export type AmountParseCode = "empty" | "invalid" | "too_many_decimals" | "too_large";

const GROUPERS = /[\s']/g; // \s covers NBSP, narrow NBSP and thin space

/**
 * Parses what a person typed into integer minor units at the line's exponent.
 * Accepts "." or "," as the decimal mark. If both appear, the last one is the
 * decimal mark and the other is a group separator. A single mark that appears
 * more than once is a group separator. No sign: the operation gives the sign.
 * "1 234,56" and "1234.56" both give 123456 at exponent 2. "1.5" at exponent 0
 * is refused.
 *
 * At exponent 0 there are no decimals, so a single mark followed by exactly three
 * digits is a group separator: "1,000" (en) and "1.000" (de) give 1000, which is
 * how formatAmount shows a count of a thousand (PETTY-351). At exponent 1 and up
 * the same "1,234" stays a decimal mark and is refused: for money it is ambiguous.
 */
export function parseAmount(text: string, exponent: number): number {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_EXPONENT) throw new LedgerError("bad_exponent");
  const s = text.replace(GROUPERS, "");
  if (s.length === 0) throw new LedgerError("empty");
  if (!/^[0-9.,]+$/.test(s)) throw new LedgerError("invalid");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalMark: "." | "," | null = null;
  if (lastDot >= 0 && lastComma >= 0) decimalMark = lastDot > lastComma ? "." : ",";
  else if (lastDot >= 0) decimalMark = s.indexOf(".") === lastDot ? "." : null;
  else if (lastComma >= 0) decimalMark = s.indexOf(",") === lastComma ? "," : null;
  if (decimalMark && exponent === 0 && /^\d{1,3}[.,]\d{3}$/.test(s)) decimalMark = null;
  let intPart: string;
  let fracPart = "";
  if (decimalMark) {
    const i = s.lastIndexOf(decimalMark);
    intPart = s.slice(0, i);
    fracPart = s.slice(i + 1);
  } else {
    intPart = s;
  }
  if (/[.,]/.test(intPart)) {
    // Group separators must split the integer part into 1–3 digits then groups of exactly 3.
    const groups = intPart.split(/[.,]/);
    if (groups.some((g, i) => (i === 0 ? g.length < 1 || g.length > 3 : g.length !== 3))) throw new LedgerError("invalid");
    intPart = groups.join("");
  }
  if (fracPart.includes(".") || fracPart.includes(",")) throw new LedgerError("invalid");
  if (intPart.length === 0 && fracPart.length === 0) throw new LedgerError("invalid");
  if (fracPart.length > exponent) throw new LedgerError("too_many_decimals");
  const digits = (intPart || "0") + fracPart.padEnd(exponent, "0");
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) throw new LedgerError("too_large");
  return n;
}

function partsOf(locale: string): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
  return {
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    group: parts.find((p) => p.type === "group")?.value ?? "",
  };
}

/** The decimal mark for the keypad in this locale ("," for pl, "." for en). */
export function decimalSeparator(locale: string): string {
  return partsOf(locale).decimal;
}

/**
 * Formats minor units at the given exponent with locale grouping and decimal
 * mark. Exact: the integer is never divided by a float. "123456" @2 in pl →
 * "1 234,56"; in en → "1,234.56"; "1000" @0 → "1 000" / "1,000".
 */
export function formatAmount(minor: number, exponent: number, locale: string): string {
  if (!Number.isSafeInteger(minor)) throw new LedgerError("amount_not_integer");
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_EXPONENT) throw new LedgerError("bad_exponent");
  const negative = minor < 0;
  const digits = Math.abs(minor).toString().padStart(exponent + 1, "0");
  const intDigits = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent);
  // "always": Polish would otherwise leave 4-digit numbers ungrouped ("2340"); the spec shows "2 340".
  const intFormatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: "always" } as unknown as Intl.NumberFormatOptions).format(BigInt(intDigits));
  const { decimal } = partsOf(locale);
  const body = exponent > 0 ? `${intFormatted}${decimal}${frac}` : intFormatted;
  return negative ? `−${body}` : body;
}

/** "1 234,56 PLN" — number then code, always, for known and unknown codes alike. */
export function formatMoney(minor: number, exponent: number, currency: string, locale: string): string {
  return `${formatAmount(minor, exponent, locale)} ${normalizeCurrencyCode(currency)}`;
}

export function formatCount(count: number, locale: string): string {
  return formatAmount(count, 0, locale);
}
