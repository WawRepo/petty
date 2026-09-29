import type { TFunction } from "i18next";

/** The locale dates are written in: the app's English is British ("colour"), so its dates are too (PETTY-281). */
export const dateLocale = (lang: string): string => (lang === "en" ? "en-GB" : lang);

/**
 * "3 days ago" / "3 dni temu" via Intl.RelativeTimeFormat — plural forms come
 * from the locale data, never from string joining (spec: i18n). Under a
 * minute is a dictionary key; over ~30 days it is a date.
 */
export function relativeTime(iso: string, locale: string, t: TFunction, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t("time.justNow");
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return new Intl.DateTimeFormat(dateLocale(locale), { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}
