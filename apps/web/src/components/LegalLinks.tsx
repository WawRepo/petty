import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { hasLegal } from "../lib/legal.js";
import { Button } from "./Button.js";

/**
 * Under a sign-up form (PETTY-342): the privacy notice is given where the data is collected (GDPR
 * Art. 13), and the terms, when this Petty has them, are accepted by creating the account.
 */
export function SignUpLegal() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const terms = hasLegal("terms");
  return (
    <div className="mt12" data-testid="signup-legal">
      <p className="hint m0">{terms ? `${t("legal.acceptTerms")} ${t("legal.privacyNote")}` : t("legal.privacyNote")}</p>
      <div className="actions m0">
        {terms ? <Button variant="ghost" onClick={() => nav("/terms")}>{t("terms.link")}</Button> : null}
        <Button variant="ghost" onClick={() => nav("/privacy")}>{t("privacy.link")}</Button>
      </div>
    </div>
  );
}
