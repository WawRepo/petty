import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "./Button.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { Sheet } from "./Sheet.js";
import { initial } from "../lib/format.js";
import { signOut, useAuth } from "../lib/session.js";

/**
 * The account button (PETTY-82): the person's initial in the top bar of every signed-in page. It opens
 * Settings, Places and Sign out, so signing out is one tap away at any level, and the home bar carries
 * the same kind of controls as the sub pages (an icon, not a text button and a gear).
 */
export function AccountMenu() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  if (auth.status !== "unlocked") return null;
  const name = auth.me.display_name;
  return (
    <>
      <button type="button" className="avatar-btn" aria-label={t("nav.account")} aria-haspopup="dialog" onClick={() => setOpen(true)} data-testid="account-menu"><span className="avatar">{initial(name)}</span></button>
      <Sheet open={open} title={name} onClose={() => setOpen(false)}>
        {/* UX review (PETTY-82): the email says whose account this is; Places first (used most); Sign out quiet and apart — it is safe and reversible. */}
        <p className="hint mb12">{auth.me.email}</p>
        <div className="menu">
          <Button variant="secondary" onClick={() => { setOpen(false); nav("/places"); }}>{t("places.manage")}</Button>
          <Button variant="secondary" onClick={() => { setOpen(false); nav("/settings"); }}>{t("nav.settings")}</Button>
          <Button variant="secondary" className="menu-apart" onClick={() => { setOpen(false); setLeaving(true); }} data-testid="menu-sign-out">{t("auth.signOut")}</Button>
        </div>
      </Sheet>
      <ConfirmSheet open={leaving} title={t("home.signOutTitle")} body={t("home.signOutBody")} confirmLabel={t("auth.signOut")} danger={false} onClose={() => setLeaving(false)}
        onConfirm={async () => { await signOut(); nav("/", { replace: true }); }} />
    </>
  );
}
