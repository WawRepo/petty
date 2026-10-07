import { useTranslation } from "react-i18next";
import { useBack } from "../lib/nav.js";
import { CodeText } from "../components/CodeText.js";
import { Button } from "../components/Button.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { appVersion } from "../lib/authConfig.js";
import { sourceUrlFor } from "../lib/links.js";

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
  const file = `${location.origin}/downloads/petty-mcp.mjs`;
  // The program lives in ~/.petty (where it also looks for a token file); --print-config then prints the
  // settings block with this machine's absolute paths, so nobody types a path into JSON by hand.
  const unix = `mkdir -p ~/.petty && curl -fsSL ${file} -o ~/.petty/petty-mcp.mjs\nnode ~/.petty/petty-mcp.mjs --print-config ${api}`;
  const windows = `New-Item -ItemType Directory -Force "$HOME\\.petty" | Out-Null; Invoke-WebRequest ${file} -OutFile "$HOME\\.petty\\petty-mcp.mjs"\nnode "$HOME\\.petty\\petty-mcp.mjs" --print-config ${api}`;
  const config = JSON.stringify({ mcpServers: { petty: { command: "/usr/local/bin/node", args: ["/Users/you/.petty/petty-mcp.mjs"], env: { PETTY_TOKEN: "petty_pat_…", PETTY_API_URL: api } } } }, null, 2);
  const claudeCode = `claude mcp add -s user petty --env PETTY_TOKEN=petty_pat_… --env PETTY_API_URL=${api} -- node ~/.petty/petty-mcp.mjs`;
  // PETTY-274: the command line signs in through this Petty's /device page, so no token is pasted anywhere
  const cli = `${location.origin}/downloads/petty.mjs`;
  // PETTY-279: ~/.local/bin is not on macOS's PATH by default, so the first run names the file itself
  const cliUnix = `mkdir -p ~/.local/bin && curl -fsSL ${cli} -o ~/.local/bin/petty && chmod +x ~/.local/bin/petty\n~/.local/bin/petty auth login --host ${location.origin}`;
  const cliClaude = "claude mcp add -s user petty -- ~/.local/bin/petty mcp";
  const cliWindows = `New-Item -ItemType Directory -Force "$HOME\\.petty" | Out-Null; Invoke-WebRequest ${cli} -OutFile "$HOME\\.petty\\petty.mjs"\nnode "$HOME\\.petty\\petty.mjs" auth login --host ${location.origin}`;
  const list = (key: string) => (t(key, { returnObjects: true }) as string[]).map((s, i) => <li key={i} className="mb6"><CodeText text={s} /></li>);
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
          <p className="hint mb4">{t("ai.unix")}</p>
          <pre className="codeblock" data-testid="ai-install-unix">{unix}</pre>
          <p className="mt4 mb12"><Button variant="secondary" onClick={() => copy(unix)}>{t("app.copy")}</Button></p>
          <p className="hint mb4">{t("ai.windows")}</p>
          <pre className="codeblock" data-testid="ai-install-windows">{windows}</pre>
          <p className="mt4 mb12"><Button variant="secondary" onClick={() => copy(windows)}>{t("app.copy")}</Button></p>
          <p className="hint mb4">{t("ai.manual")}</p>
          <p className="m0 mb12"><a className="btn btn-secondary" href="/downloads/petty-mcp.mjs" download="petty-mcp.mjs">{t("ai.download")}</a></p>
          <p className="hint mb4">{t("ai.example")}</p>
          {/* an example only (its paths are made up), so it has no copy button: --print-config prints the real one */}
          <pre className="codeblock mb12" data-testid="ai-config">{config}</pre>
          <p className="hint mb4">{t("ai.claudeCode")}</p>
          <pre className="codeblock">{claudeCode}</pre>
          <p className="mt4 mb0"><Button variant="secondary" onClick={() => copy(claudeCode)}>{t("app.copy")}</Button></p>
        </section>
        <section className="card" data-testid="ai-cli">
          <h2 className="h-card">{t("ai.cliTitle")}</h2>
          <p className="hint"><CodeText text={t("ai.cliIntro")} /></p>
          <ol className="list">{list("ai.cliSteps")}</ol>
          <p className="hint mb4">{t("ai.unix")}</p>
          <pre className="codeblock" data-testid="ai-cli-unix">{cliUnix}</pre>
          <p className="mt4 mb12"><Button variant="secondary" onClick={() => copy(cliUnix)}>{t("app.copy")}</Button></p>
          <p className="hint mb12" data-testid="ai-cli-path"><CodeText text={t("ai.cliPath")} /></p>
          {/* PETTY-333: Claude Code starts petty by its full path, for every project */}
          <p className="hint mb4">{t("ai.cliClaude")}</p>
          <pre className="codeblock" data-testid="ai-cli-claude">{cliClaude}</pre>
          <p className="mt4 mb12"><Button variant="secondary" onClick={() => copy(cliClaude)}>{t("app.copy")}</Button></p>
          <p className="hint mb4">{t("ai.windows")}</p>
          <pre className="codeblock" data-testid="ai-cli-windows">{cliWindows}</pre>
          <p className="mt4 mb12"><Button variant="secondary" onClick={() => copy(cliWindows)}>{t("app.copy")}</Button></p>
          <p className="m0"><a className="btn btn-secondary" href="/downloads/petty.mjs" download="petty.mjs">{t("ai.cliDownload")}</a></p>
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
          <p className="m0"><a href={sourceUrlFor(appVersion())} target="_blank" rel="noopener noreferrer" data-testid="ai-source">{t("ai.source")}</a></p>
        </section>
      </main>
    </>
  );
}
