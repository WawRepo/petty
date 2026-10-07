import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.js";
import { useToast } from "./Toast.js";

/**
 * "Set it up in your app" (PETTY-316/319), on the landing page and, since PETTY-333, in Settings for
 * someone signed in: a row of AI apps, and the chosen app's setup with this Petty's own address filled
 * in, so the lines can be pasted as they are.
 *
 * PETTY-333: the Claude Code line used to be only `claude mcp add petty -- petty mcp`, which assumes the
 * petty command line is already installed, on the PATH and signed in. Run alone, Claude Code reported
 * "Failed to reconnect to petty: ENOENT" (no such program) and offered nowhere to give an address. Now
 * it is the three steps: install petty, sign in to this Petty (a page of it opens to allow that), and
 * add it to Claude Code by its full path — ~/.local/bin is often not on the PATH Claude Code starts
 * programs with — for every project (`-s user`), not only the folder it was typed in. The editors' lines
 * download petty-mcp.mjs too, instead of asking for it to be saved by hand.
 */
const APPS = ["desktop", "code", "cursor", "vscode", "windsurf", "any"] as const;
type App = (typeof APPS)[number];
const EDITORS: readonly App[] = ["cursor", "vscode", "windsurf"];

export function aiSetupLines(app: App, origin: string): string | null {
  switch (app) {
    case "desktop": return `${origin}/api`;
    case "code": return [
      `mkdir -p ~/.local/bin && curl -fsSL ${origin}/downloads/petty.mjs -o ~/.local/bin/petty && chmod +x ~/.local/bin/petty`,
      `~/.local/bin/petty auth login --host ${origin}`,
      "claude mcp add -s user petty -- ~/.local/bin/petty mcp",
    ].join("\n");
    case "any": return "io.github.WawRepo/petty";
    default: return [
      `mkdir -p ~/.petty && curl -fsSL ${origin}/downloads/petty-mcp.mjs -o ~/.petty/petty-mcp.mjs`,
      `node ~/.petty/petty-mcp.mjs --print-config ${origin}/api`,
    ].join("\n");
  }
}

export function AiSetup({ titleId }: { titleId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [app, setApp] = useState<App>("desktop");
  const name = t(`landing.ai.apps.${app}`);
  const lines = aiSetupLines(app, location.origin);
  const setup = t(EDITORS.includes(app) ? "landing.ai.setup.editor" : `landing.ai.setup.${app}`, { app: name });
  const copy = () => { if (lines) void navigator.clipboard?.writeText(lines).then(() => toast(t("app.copied"))); };
  return (
    <>
      <div className="ai-apps" role="group" aria-labelledby={titleId}>
        {APPS.map((a) => (
          <button type="button" key={a} className="ai-app" aria-pressed={a === app} onClick={() => setApp(a)} data-testid={`ai-app-${a}`}>
            {t(`landing.ai.apps.${a}`)}
          </button>
        ))}
      </div>
      <div className="ai-setup" data-testid="ai-setup" aria-live="polite">
        <p className="m0 fw700" data-testid="ai-setup-app">{name}</p>
        <p className="m0">{setup}</p>
        {lines ? <code className="ai-command" data-testid="ai-command">{lines}</code> : null}
        <div className="ai-setup-actions">
          {lines && app !== "any" ? <Button variant="secondary" onClick={copy} data-testid="ai-copy">{t("app.copy")}</Button> : null}
          {app === "desktop" ? <a className="btn btn-secondary" href="/downloads/petty.mcpb" download="petty.mcpb" data-testid="ai-mcpb">{t("tokens.addonDownload")}</a> : null}
        </div>
        {app === "code" || EDITORS.includes(app) ? <p className="hint m0" data-testid="ai-windows">{t("landing.ai.setup.windows")}</p> : null}
      </div>
    </>
  );
}
