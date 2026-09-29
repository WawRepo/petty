import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/session.js";
import { AccountMenu } from "./AccountMenu.js";
import { LanguagePicker } from "./LanguagePicker.js";

/** `titleAs`: "p" when the page's own heading is its message (the 404), so the page has one h1 (PETTY-280, F20). */
interface Props { title: string; onBack?: () => void; actions?: ReactNode; brand?: boolean; titleAs?: "h1" | "p" }
/**
 * Every page's bar: back or the brand on the left, the page's own actions and the account button on
 * the right (PETTY-82). Signed out (sign in, join, unlock, reset, privacy, the AI page) the account
 * button's place holds the language switch (PETTY-249); signed in, it is in Settings.
 */
export function TopBar({ title, onBack, actions, brand = false, titleAs: Title = "h1" }: Props) {
  const { t } = useTranslation();
  const auth = useAuth();
  return (
    <header className="topbar">
      {onBack ? <button type="button" className="back" onClick={onBack} aria-label={t("app.back")}>‹</button> : null}
      {brand ? <span className="brand"><img src="/icon.svg" alt="" width="28" height="28" /><Title className="bar-title">{title}</Title></span> : <Title className="bar-title">{title}</Title>}
      {actions}
      {auth.status === "unlocked" ? <AccountMenu /> : <LanguagePicker compact />}
    </header>
  );
}
