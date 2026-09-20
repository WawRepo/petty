import { useTranslation } from "react-i18next";
import { useBack } from "../lib/nav.js";
import { Button } from "../components/Button.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { SOURCE_URL } from "../lib/links.js";

/**
 * "Use Petty with AI" (PETTY-173): how to connect an AI app through an access token and the local
 * MCP program, from scratch. Public, like the privacy page. The config blocks carry this Petty's
 * own address; the token is always a placeholder, never filled in here.
 */
const TOOLS: readonly (readonly [string, "read" | "write"])[] = [
  ["list_drawers", "read"], ["find_item", "read"], ["history", "read"], ["list_tags", "read"], ["list_places", "read"],
  ["add", "write"], ["withdraw", "write"], ["adjust", "write"], ["tag_item", "write"], ["untag_item", "write"],
  ["rename_tag", "write"], ["remove_tag", "write"], ["move_drawer", "write"],
];

export function AiScreen() {
  const { t } = useTranslation();
  const back = useBack("/");
  const toast = useToast();
  const api = `${location.origin}/api`;
  const config = JSON.stringify({ mcpServers: { petty: { command: "node", args: ["/path/to/petty-mcp.mjs"], env: { PETTY_TOKEN: "petty_pat_…", PETTY_API_URL: api } } } }, null, 2);
  const claudeCode = `claude mcp add petty --env PETTY_TOKEN=petty_pat_… --env PETTY_API_URL=${api} -- node /path/to/petty-mcp.mjs`;
  const list = (key: string) => (t(key, { returnObjects: true }) as string[]).map((s, i) => <li key={i} className="mb6">{s}</li>);
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast(t("app.copied"))); };
  return (
    <>
      <TopBar title={t("ai.title")} onBack={back} />
      <main className="stack">
        <p>{t("ai.intro")}</p>
        <section className="card">
          <h2 className="h-card">{t("ai.tokenTitle")}</h2>
          <ol className="list mb0">{list("ai.tokenSteps")}</ol>
        </section>
        <section className="card" data-testid="ai-desktop">
          <h2 className="h-card">{t("ai.desktopTitle")}</h2>
          <ol className="list">{list("ai.desktopSteps")}</ol>
          <div className="field">
            <label htmlFor="ai-address">{t("tokens.address")}</label>
            <input id="ai-address" readOnly value={api} data-testid="ai-address" onFocus={(e) => e.currentTarget.select()} />
          </div>
          <p className="m0"><a className="btn btn-secondary" href="/downloads/petty.mcpb" download="petty.mcpb">{t("tokens.addonDownload")}</a></p>
        </section>
        <section className="card" data-testid="ai-other">
          <h2 className="h-card">{t("ai.otherTitle")}</h2>
          <ol className="list">{list("ai.otherSteps")}</ol>
          <p className="m0 mb8"><a className="btn btn-secondary" href="/downloads/petty-mcp.mjs" download="petty-mcp.mjs">{t("ai.download")}</a></p>
          <pre className="codeblock" data-testid="ai-config">{config}</pre>
          <p className="mt4 mb12"><Button variant="secondary" onClick={() => copy(config)}>{t("ai.copyConfig")}</Button></p>
          <p className="hint mb4">{t("ai.claudeCode")}</p>
          <pre className="codeblock">{claudeCode}</pre>
          <p className="mt4 mb0"><Button variant="secondary" onClick={() => copy(claudeCode)}>{t("app.copy")}</Button></p>
        </section>
        <section className="card">
          <h2 className="h-card">{t("ai.askTitle")}</h2>
          <ul className="list mb0">{list("ai.ask")}</ul>
        </section>
        <section className="card">
          <h2 className="h-card">{t("ai.toolsTitle")}</h2>
          <p className="hint">{t("ai.toolsHint")}</p>
          <ul className="list mb0" data-testid="ai-tools">
            {TOOLS.map(([name, need]) => <li key={name}><code>{name}</code> · {t(`ai.need.${need}`)} · {t(`ai.tool.${name}`)}</li>)}
          </ul>
        </section>
        <section className="card">
          <h2 className="h-card">{t("ai.honestTitle")}</h2>
          <ul className="list">{list("ai.honest")}</ul>
          <p className="m0"><a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-testid="ai-source">{t("ai.source")}</a></p>
        </section>
      </main>
    </>
  );
}
