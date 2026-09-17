import { useTranslation } from "react-i18next";
import { useBack } from "../lib/nav.js";
import { TopBar } from "../components/TopBar.js";

/** Spec "What the server still learns" and the threat model, in plain words, on a public page. */
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
        <section className="card"><h2 className="h-card">{t("privacy.notTitle")}</h2><ul className="list mb0">{list("privacy.not")}</ul></section>
      </main>
    </>
  );
}
