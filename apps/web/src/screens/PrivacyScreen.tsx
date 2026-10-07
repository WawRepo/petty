import { useTranslation } from "react-i18next";
import { appVersion, isClerk } from "../lib/authConfig.js";
import { useBack } from "../lib/nav.js";
import { TopBar } from "../components/TopBar.js";
import { sourceUrlFor } from "../lib/links.js";
import { hasLegal } from "../lib/legal.js";
import { LegalText } from "../components/LegalText.js";

/**
 * Spec "What the server still learns" and the threat model, in plain words, on a public page. Then, when
 * this deployment has one (PETTY-342), the operator's own privacy notice: who runs it, its providers, how
 * long data is kept, the rights.
 */
export function PrivacyScreen() {
  const { t } = useTranslation();
  const back = useBack("/");
  const list = (key: string) => (t(key, { returnObjects: true }) as string[]).map((s, i) => <li key={i}>{s}</li>);
  return (
    <>
      <TopBar title={t("privacy.title")} onBack={back} />
      <main className="stack">
        <p>{t("privacy.intro")}</p>
        <section className="card"><h2 className="h-card">{t("privacy.seesTitle")}</h2><ul className="list mb0">{list("privacy.sees")}</ul></section>
        <section className="card"><h2 className="h-card">{t("privacy.defendsTitle")}</h2><ul className="list mb0">{list("privacy.defends")}</ul></section>
        <section className="card"><h2 className="h-card">{t("privacy.notTitle")}</h2><ul className="list mb0">{list("privacy.not")}{isClerk() ? <li>{t("privacy.notClerk")}</li> : null}</ul></section>
        {hasLegal("privacy") ? <LegalText doc="privacy" /> : null}
        <p className="hint">{t("privacy.source")} <a href={sourceUrlFor(appVersion())} target="_blank" rel="noopener noreferrer" data-testid="privacy-source">{t("app.sourceCode")}</a></p>
      </main>
    </>
  );
}
