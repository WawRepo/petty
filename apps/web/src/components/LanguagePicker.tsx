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
  return (
    <span className="lang-picker">
      <Languages size={16} aria-hidden="true" />
      <label htmlFor={id} className="sr-only">{t("settings.language")}</label>
      {select}
    </span>
  );
}
