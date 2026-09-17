import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AccountMenu } from "./AccountMenu.js";

interface Props { title: string; onBack?: () => void; actions?: ReactNode; brand?: boolean }
/** Every page's bar: back or the brand on the left, the page's own actions and the account button on the right (PETTY-82). */
export function TopBar({ title, onBack, actions, brand = false }: Props) {
  const { t } = useTranslation();
  return (
    <header className="topbar">
      {onBack ? <button type="button" className="back" onClick={onBack} aria-label={t("app.back")}>‹</button> : null}
      {brand ? <span className="brand"><img src="/icon.svg" alt="" width="28" height="28" /><h1>{title}</h1></span> : <h1>{title}</h1>}
      {actions}
      <AccountMenu />
    </header>
  );
}
