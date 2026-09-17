import { formatCount, formatMoney } from "@petty/ledger";
import type { Line } from "@petty/ledger";
import type { TFunction } from "i18next";

/** "1 234,56 PLN" for money, "56 balls" for countables, "" for single items. */
export function quantityLabel(line: Line, balance: number, locale: string, t: TFunction): string {
  if (line.kind === "money") return formatMoney(balance, line.exponent, line.currency, locale);
  if (line.kind === "countable") return `${formatCount(balance, locale)} ${line.unit.trim() || t("drawer.line.items")}`;
  return "";
}
export const initial = (name: string): string => (name.trim()[0] ?? "?").toUpperCase();
