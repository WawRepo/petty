import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { currentLocale, LOCALE_NAMES, LOCALES, setLocale, type Locale } from "../i18n/index.js";

/**
 * The one language switch (PETTY-249): the landing page's header, every signed-out page's top bar
 * and Settings. Languages are listed in their own names. `onPick` runs after the switch — Settings
 * uses it to store the choice on the account, so emails follow it too.
 */
export function LanguagePicker({ compact = false, onPick, testId = "language-picker" }: { compact?: boolean; onPick?: (l: Locale) => void; testId?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const pick = (l: Locale) => { void setLocale(l).then(() => onPick?.(l)); };
  const select = (
    <select id={id} value={currentLocale()} onChange={(e) => pick(e.target.value as Locale)} data-testid={testId}>
      {LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_NAMES[l]}</option>)}
    </select>
  );
  if (!compact) {
    return (
      <div className="field">
        <label htmlFor={id}>{t("settings.language")}</label>
        {select}
      </div>
    );
  }
  // PETTY-331: a <select> is as wide as its longest option ("Français"), so a short choice sat left of
  // centre. The pill people see is sized to the chosen name; the select lies over it, unseen, and is
  // still the control a tap, a keyboard and a screen reader use.
  return (
    <span className="lang-picker">
      <span className="lang-face" aria-hidden="true" data-testid={`${testId}-face`}><Languages size={16} />{LOCALE_NAMES[currentLocale()]}</span>
      <label htmlFor={id} className="sr-only">{t("settings.language")}</label>
      {select}
    </span>
  );
}
