import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "./Button.js";
import { promptInstall, useInstallState } from "../lib/install.js";
import { hasKnownPasskey, passkeyAvailable, passkeyPrfSupported } from "../lib/passkey.js";
import { useAuth } from "../lib/session.js";

const PASSKEY_KEY = "petty.passkeyNudge";
const INSTALL_KEY = "petty.installNudge";
const VISITS_KEY = "petty.visits";
const INSTALL_AFTER_VISITS = 3;

/** One count per page load: the install offer waits for the third visit. */
let counted = false;
function visits(): number {
  try {
    let n = Number(localStorage.getItem(VISITS_KEY) ?? 0) || 0;
    if (!counted) { counted = true; n += 1; localStorage.setItem(VISITS_KEY, String(n)); }
    return n;
  } catch { return 0; }
}
const flag = (k: string) => { try { return localStorage.getItem(k) === "no"; } catch { return false; } };
const setFlag = (k: string) => { try { localStorage.setItem(k, "no"); } catch { /* ignore */ } };

/**
 * At most ONE nudge on the home screen, one line, under the total card (PETTY-113, audit F6).
 * Order: a passkey for this device first (it makes every next unlock a tap); the install offer
 * only from the third visit on, and only when nothing else is asking. Each is dismissed once and
 * stays away; Settings keeps both offers available.
 */
export function Nudges() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const auth = useAuth();
  const install = useInstallState();
  // Start from the synchronous answer so the nudge is in the first paint and nothing shifts under it (PETTY-118); the async PRF check can only turn it off.
  const [prf, setPrf] = useState(() => passkeyAvailable());
  const [pkGone, setPkGone] = useState(() => flag(PASSKEY_KEY));
  const [instGone, setInstGone] = useState(() => flag(INSTALL_KEY));
  const [n] = useState(visits);
  useEffect(() => { void passkeyPrfSupported().then(setPrf); }, []);
  if (auth.status !== "unlocked") return null;
  if (prf && !pkGone && !hasKnownPasskey(auth.me.passkeys)) {
    return (
      <div className="nudge" role="status" data-testid="passkey-nudge">
        <span className="nudge-text">{t("settings.passkey.nudge")}</span>
        <span className="nudge-actions">
          <Button variant="secondary" onClick={() => nav("/settings")}>{t("settings.passkey.nudgeGo")}</Button>
          <Button variant="ghost" onClick={() => { setFlag(PASSKEY_KEY); setPkGone(true); }}>{t("settings.passkey.nudgeLater")}</Button>
        </span>
      </div>
    );
  }
  if (!instGone && n >= INSTALL_AFTER_VISITS && (install === "prompt" || install === "ios")) {
    return (
      <div className="nudge" role="status" data-testid="install-nudge">
        <span className="nudge-text">{install === "ios" ? t("install.ios") : t("install.nudge")}</span>
        <span className="nudge-actions">
          {install === "prompt" ? <Button variant="secondary" onClick={() => { void promptInstall(); }}>{t("install.button")}</Button> : null}
          <Button variant="ghost" onClick={() => { setFlag(INSTALL_KEY); setInstGone(true); }}>{t("install.dismiss")}</Button>
        </span>
      </div>
    );
  }
  return null;
}
