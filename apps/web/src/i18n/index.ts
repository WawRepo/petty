import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import en from "./en.json";

/** PETTY-249: the app's languages. English is built in; the others load on demand (about 60 KB each). */
export const LOCALES = ["en", "pl", "de", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
/** Each language's name in that language (an autonym): the same in every dictionary, so a reader always finds their own. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", pl: "Polski", de: "Deutsch", es: "Español", fr: "Français" };
export const isLocale = (x: string): x is Locale => (LOCALES as readonly string[]).includes(x);

const LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: unknown }>> = {
  pl: () => import("./pl.json"),
  de: () => import("./de.json"),
  es: () => import("./es.json"),
  fr: () => import("./fr.json"),
};

/** A choice made on this device wins; otherwise the first of the browser's languages that Petty speaks. */
function detect(): Locale {
  try {
    const saved = localStorage.getItem("petty.locale");
    if (saved && isLocale(saved)) return saved;
  } catch { /* storage blocked */ }
  for (const lang of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = (lang ?? "").toLowerCase().split("-")[0] ?? "";
    if (isLocale(base)) return base;
  }
  return "en";
}

/**
 * Dictionaries keyed by semantic ids; ICU plurals (Polish one / few / many; the others one / other).
 * English is the fallback for a missing key, and `pnpm i18n:check` makes a missing key, a broken
 * message or a changed placeholder a build failure rather than a silent fallback.
 */
export const i18n = i18next.use(ICU).use(initReactI18next);

async function load(locale: Locale): Promise<void> {
  if (locale === "en" || i18n.hasResourceBundle(locale, "translation")) return;
  const m = await LOADERS[locale]();
  i18n.addResourceBundle(locale, "translation", m.default as Record<string, unknown>, true, true);
}

const initial = detect();
/** Resolves once the first language is in; main.tsx renders after it. If its file fails to load, English shows. */
export const i18nReady: Promise<void> = i18n
  .init({
    resources: { en: { translation: en } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
  })
  .then(() => load(initial))
  .then(() => i18n.changeLanguage(initial))
  .then(() => { document.documentElement.lang = initial; })
  .catch(() => { document.documentElement.lang = "en"; });

export async function setLocale(locale: Locale): Promise<void> {
  try { localStorage.setItem("petty.locale", locale); } catch { /* storage blocked */ }
  await load(locale).catch(() => undefined);
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}

/** The language on screen, as one of LOCALES. */
export function currentLocale(): Locale {
  return isLocale(i18n.language) ? i18n.language : "en";
}
