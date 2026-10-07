import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Lock, MessageCircle } from "lucide-react";
import { formatAmount } from "@petty/ledger";
import { currentLocale } from "../i18n/index.js";
import { CodeText } from "./CodeText.js";
import { AiSetup } from "./AiSetup.js";

/**
 * "Works with your AI app" on the landing page, after "One idea, many uses" (PETTY-316, design B of
 * PETTY-315; order and layout D of PETTY-319). Petty's MCP add-on works with any app that runs local MCP
 * servers, so the section names MCP, then shows a short example conversation that names no app (a
 * question, an answer, and a change the assistant asks about before making it), then "Set it up in your
 * app" (AiSetup, shared with Settings since PETTY-333): a row of apps whose buttons switch the setup
 * lines. The lines are the real ones (docs/agent.md, docs/cli.md) with this Petty's own address. Apps
 * that only take remote connectors are left out on purpose: those would need the server to decrypt
 * (docs/decisions.md).
 *
 * The conversation is an illustration, not a capture: its words come from the dictionaries, its amounts
 * are formatted for the visitor's language and use EUR, like the screenshots, never a local currency.
 */
export function AiShowcase() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const locale = currentLocale();
  const eur = (minor: number) => `${formatAmount(minor, 2, locale)} EUR`;
  return (
    <section className="ai-show" id="ai" data-testid="ai-show" aria-labelledby="ai-show-title">
      <div className="ai-show-head">
        <p className="ai-eyebrow m0">{t("landing.ai.eyebrow")}</p>
        <h2 className="landing-h2 m0" id="ai-show-title">{t("landing.ai.title")}</h2>
        <p className="hint m0">{t("landing.ai.body")}</p>
      </div>

      {/* PETTY-319: the example first, for any app; the setup per app under it */}
      <figure className="ai-chat m0" aria-label={t("landing.ai.chat.label")}>
        <div className="ai-chat-head">
          <span className="ai-chat-app" data-testid="ai-chat-app"><MessageCircle size={18} aria-hidden="true" />{t("landing.ai.chat.app")}</span>
          <span className="ai-chat-local"><Lock size={14} aria-hidden="true" />{t("landing.ai.chat.local")}</span>
        </div>
        <p className="ai-msg ai-user">{t("landing.ai.chat.q1")}</p>
        <p className="ai-tool"><Lock size={12} aria-hidden="true" />{t("landing.ai.chat.tool1")}</p>
        <p className="ai-msg ai-bot">{t("landing.ai.chat.a1")}</p>
        <p className="ai-msg ai-user">{t("landing.ai.chat.q2")}</p>
        <p className="ai-msg ai-bot">{t("landing.ai.chat.a2", { amount: eur(2000) })}</p>
        <p className="ai-msg ai-user">{t("landing.ai.chat.q3")}</p>
        <p className="ai-tool"><Lock size={12} aria-hidden="true" />{t("landing.ai.chat.tool2", { amount: eur(2000) })}</p>
        <p className="ai-msg ai-bot">{t("landing.ai.chat.a3", { amount: eur(10050) })}</p>
      </figure>

      <h3 className="ai-setup-title m0" id="ai-setup-title">{t("landing.ai.setupHeading")}</h3>
      <AiSetup titleId="ai-setup-title" />

      <p className="m0"><button type="button" className="btn btn-primary" onClick={() => nav("/ai")} data-testid="ai-show-more">{t("ai.link")}</button></p>
      <ul className="ai-badges" aria-label={t("landing.ai.badgesLabel")}>
        <li className="ai-badge">{t("landing.ai.badges.standard")}</li>
        <li className="ai-badge">{t("landing.ai.badges.registry")} <code>io.github.WawRepo/petty</code></li>
        <li className="ai-badge">{t("landing.ai.badges.local")}</li>
      </ul>
      <p className="hint m0 ai-cli"><CodeText text={t("landing.ai.cli")} /></p>
    </section>
  );
}
