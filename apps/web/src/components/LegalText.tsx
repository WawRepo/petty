import { useTranslation } from "react-i18next";
import { currentLocale } from "../i18n/index.js";
import { useLegalText, type LegalDoc } from "../lib/legal.js";
import { Markdown } from "./Markdown.js";

/** The operator's text in the language on screen, or the nearest one the operator wrote (PETTY-342). */
export function LegalText({ doc }: { doc: LegalDoc }) {
  const { t, i18n } = useTranslation();
  void i18n.language; // re-render on a language change
  const { text, failed } = useLegalText(doc, currentLocale());
  if (failed) return <p className="error" role="alert" data-testid={`legal-${doc}-failed`}>{t("legal.failed")}</p>;
  if (text === null) return <p className="hint" aria-busy="true">{t("app.loading")}</p>;
  return <section className="card"><Markdown text={text} testId={`legal-${doc}`} /></section>;
}
