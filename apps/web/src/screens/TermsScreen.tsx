import { useTranslation } from "react-i18next";
import { TopBar } from "../components/TopBar.js";
import { LegalText } from "../components/LegalText.js";
import { hasLegal } from "../lib/legal.js";
import { useBack } from "../lib/nav.js";

/** The operator's terms of service (PETTY-342): a public page, like the privacy page. */
export function TermsScreen() {
  const { t } = useTranslation();
  const back = useBack("/");
  return (
    <>
      <TopBar title={t("terms.title")} onBack={back} />
      <main className="stack">
        {hasLegal("terms") ? <LegalText doc="terms" /> : <p data-testid="terms-none">{t("terms.none")}</p>}
      </main>
    </>
  );
}
