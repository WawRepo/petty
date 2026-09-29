import { useTranslation } from "react-i18next";
import { decimalSeparator } from "@petty/ledger";

interface Props { value: string; onChange: (v: string) => void; allowDecimal: boolean; maxLength?: number; maxDecimals?: number }
/**
 * The prototype's keypad, with a locale-aware decimal key (spec: i18n — "," in
 * Polish). Emits a raw string; `parseAmount` from @petty/ledger turns it into
 * minor units. Not wired to any screen until Phase 7.
 */
/**
 * One key applied to the raw amount string: a digit, the decimal separator, or "⌫". Shared by the
 * on-screen keys and the physical keyboard (PETTY-112). `maxDecimals`: the line's exponent — a digit past
 * it is not taken (PETTY-279: "1234.5699999 PLN" used to fail only at Review).
 */
export function applyKey(value: string, k: string, dec: string, allowDecimal: boolean, maxLength = 12, maxDecimals = Infinity): string {
  if (k === "⌫") return value.length > 1 ? value.slice(0, -1) : "0";
  if (k === dec) return allowDecimal && !value.includes(dec) ? value + dec : value;
  if (!/^[0-9]$/.test(k)) return value;
  const at = value.indexOf(dec);
  if (at >= 0 && value.length - at - 1 >= maxDecimals) return value;
  return (value === "0" ? k : value + k).slice(0, maxLength);
}

export function Keypad({ value, onChange, allowDecimal, maxLength = 12, maxDecimals }: Props) {
  const { t, i18n } = useTranslation();
  const dec = decimalSeparator(i18n.language);
  const press = (k: string) => onChange(applyKey(value, k, dec, allowDecimal, maxLength, maxDecimals));
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", dec, "0", "⌫"];
  return (
    <div className="keypad" role="group">
      {keys.map((k) => (
        <button type="button" key={k} onClick={() => press(k)} disabled={k === dec && !allowDecimal}
          aria-label={k === "⌫" ? t("keypad.delete") : k === dec ? t("keypad.decimal") : k}>
          {k}
        </button>
      ))}
    </div>
  );
}
