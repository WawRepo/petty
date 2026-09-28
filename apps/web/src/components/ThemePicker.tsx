import { useId } from "react";
import { useTranslation } from "react-i18next";
import { setTheme, THEMES, useTheme, type Theme } from "../lib/theme.js";

/** PETTY-259: the theme switch in Settings — the device's own, light or dark. Kept on this device. */
export function ThemePicker({ testId = "theme-picker" }: { testId?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const { theme } = useTheme();
  return (
    <div className="field">
      <label htmlFor={id}>{t("settings.theme.label")}</label>
      <select id={id} value={theme} onChange={(e) => setTheme(e.target.value as Theme)} data-testid={testId}>
        {THEMES.map((th) => <option key={th} value={th}>{t(`settings.theme.${th}`)}</option>)}
      </select>
    </div>
  );
}
