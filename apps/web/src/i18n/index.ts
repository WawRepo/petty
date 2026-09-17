import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import pl from "./pl.json";

export const LOCALES = ["en", "pl"] as const;
export type Locale = (typeof LOCALES)[number];

function detect(): Locale {
  try {
    const saved = localStorage.getItem("petty.locale");
    if (saved === "en" || saved === "pl") return saved;
  } catch { /* storage blocked */ }
  return navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
}

/**
 * Dictionaries keyed by semantic ids; ICU plurals (Polish one / few / many).
 * English is the fallback for a missing key, and `pnpm i18n:check` makes a
 * missing key a build failure rather than a silent fallback.
 */
export const i18n = i18next.use(ICU).use(initReactI18next);
void i18n.init({
  showSupportNotice: false, // PETTY-133: no vendor line in the console
  resources: { en: { translation: en }, pl: { translation: pl } },
  lng: detect(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function setLocale(locale: Locale): void {
  try { localStorage.setItem("petty.locale", locale); } catch { /* storage blocked */ }
  void i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}
