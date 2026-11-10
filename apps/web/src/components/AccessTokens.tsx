import { Link } from "react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Me } from "@petty/protocol";
import { WrongPassphrase } from "@petty/crypto";
import { createAccessToken, revokeAccessToken, useAccessTokens } from "../lib/accessTokens.js";
import { PasskeyError } from "../lib/passkey.js";
import { relativeTime } from "../lib/time.js";
import { Button } from "./Button.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { Sheet } from "./Sheet.js";
import { SwitchRow } from "./SwitchRow.js";
import { TextField } from "./TextField.js";
import { scopeOf, TokenScope, type ScopeChoice } from "./TokenScope.js";
import { useToast } from "./Toast.js";

const DAYS = [30, 90, 365, 0] as const;
/** What a tool needs as PETTY_API_URL: this very origin, where the app and its API live together. */
const apiAddress = `${location.origin}/api`;

/**
 * Settings → access tokens (PETTY-164). The owner makes a token for their own tools, for example
 * a Claude Desktop server. Every token carries drawer keys, so making one opens the vault again
 * (PETTY-452): the passphrase or the passkey prompt is that confirmation, also for a token that only
 * reads. The person says which drawers it may use; all of them is a choice, never what happens unasked.
 */
export function AccessTokens({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { tokens, reload } = useAccessTokens(true);
  const [name, setName] = useState("");
  // PETTY-281 (S30): a new token only reads until you switch changes on — the least it needs
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState<number>(90);
  const [scope, setScope] = useState<ScopeChoice>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);
  // The sheet is long on a phone, and its buttons stay in view over the last fields. A passphrase that is
  // missing or wrong moves the focus to its field and scrolls the field up, clear of the buttons.
  const passId = useId();
  const toPassphrase = () => { const field = document.getElementById(passId); field?.focus(); requestAnimationFrame(() => field?.scrollIntoView({ block: "start" })); }; // after the error is drawn: it adds a row

  const close = () => { setOpen(false); setName(""); setPass(""); setError(null); setWrite(false); setDays(90); setScope(null); };

  async function create() {
    const chosen = scopeOf(scope);
    if (chosen === undefined) { setError(t("tokens.scopeNeeded")); return; }
    if (me.vault && !pass && !me.passkeys.length) { setError(t("tokens.passphraseNeeded")); toPassphrase(); return; }
    setBusy(true);
    setError(null);
    try {
      const made = await createAccessToken({
        name: name.trim() || t("tokens.defaultName"),
        role: write ? "write" : "read",
        scope: chosen,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        passphrase: me.vault && pass ? pass : null,
      });
      setMade(made.token);
      close();
      reload();
    } catch (e) {
      if (e instanceof WrongPassphrase) toPassphrase();
      setError(e instanceof WrongPassphrase ? t("auth.unlock.wrong") : e instanceof PasskeyError ? t(e.code === "cancelled" ? "settings.passkey.cancelled" : "settings.passkey.unsupported") : t("errors.unknown"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="tokens-section">
      <h2 className="h-card">{t("tokens.title")}</h2>
      <p className="hint mb8"><Link to="/ai" data-testid="tokens-ai-link">{t("ai.link")}</Link></p>
      <p className="hint my6">{t("tokens.hint")}</p>
      {tokens.length ? (
        <ul className="m0 p0" data-testid="token-list">
          {tokens.map((k) => (
            <li key={k.id} className="passkey-row" data-testid="token-row">
              <span className="tag-row-name">
                <span className="switch-label">{k.name}</span>
                <span className="hint m0">
                  {t(k.role === "write" ? "tokens.mayWrite" : "tokens.mayRead")}
                  {" · "}
                  {k.scope ? t("tokens.scopeCount", { count: k.scope.length }) : t("tokens.scopeAllShort")}
                  {" · "}
                  {k.last_used_at ? t("tokens.used", { when: relativeTime(k.last_used_at, i18n.language, t) }) : t("tokens.neverUsed")}
                </span>
              </span>
              <span className="nudge-actions tag-row-actions">
                <Button variant="danger-ghost" onClick={() => setRevoking({ id: k.id, name: k.name })} aria-label={t("tokens.revokeNamed", { name: k.name })}>{t("tokens.revoke")}</Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="secondary" className="mt8" onClick={() => setOpen(true)} data-testid="token-new">{t("tokens.new")}</Button>

      <Sheet open={open} title={t("tokens.new")} onClose={close}>
        <TextField label={t("tokens.name")} value={name} maxLength={80} autoComplete="off" data-testid="token-name" placeholder={t("tokens.defaultName")} onChange={(e) => setName(e.target.value)} />
        <SwitchRow label={t("tokens.mayWriteSwitch")} hint={t("tokens.mayWriteHint")} checked={write} onChange={setWrite} testId="token-write" />
        <TokenScope value={scope} onChange={(next) => { setScope(next); setError(null); }} testId="token-scope" />
        <div className="field mt12">
          <label htmlFor="token-expiry">{t("tokens.expiry")}</label>
          <select id="token-expiry" value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="token-expiry">
            {DAYS.map((d) => <option key={d} value={d}>{d ? t("tokens.days", { count: d }) : t("tokens.never")}</option>)}
          </select>
        </div>
        <p className="hint" data-testid="token-confirm-hint">{t("tokens.confirm")}</p>
        {me.vault ? (
          <TextField id={passId} label={t("auth.unlock.passphrase")} type="password" autoComplete="current-password" value={pass} data-testid="token-passphrase"
            hint={me.passkeys.length ? t("tokens.passphraseOrPasskey") : undefined} onChange={(e) => setPass(e.target.value)} />
        ) : null}
        <div className="actions">
          {/* with the buttons, which stay in view while the sheet scrolls: an error is never below the fold */}
          {error ? <div className="error" role="alert">{error}</div> : null}
          <Button variant="secondary" onClick={close}>{t("app.cancel")}</Button>
          <Button busy={busy} onClick={() => { void create(); }} data-testid="token-create">{t("tokens.create")}</Button>
        </div>
      </Sheet>

      <Sheet open={!!made} title={t("tokens.madeTitle")} onClose={() => setMade(null)}>
        <p className="hint">{t("tokens.madeBody")}</p>
        <p className="code" data-testid="token-value">{made}</p>
        {/* PETTY-172: the easy way into Claude Desktop — one file, then paste the address and the token. */}
        <h3 className="h-card mt12">{t("tokens.addonTitle")}</h3>
        <p className="hint">{t("tokens.addonBody")}</p>
        <div className="field">
          <label htmlFor="petty-address">{t("tokens.address")}</label>
          <input id="petty-address" readOnly value={apiAddress} data-testid="token-address" onFocus={(e) => e.currentTarget.select()} />
        </div>
        <p className="m0 mb12"><a className="btn btn-secondary" href="/downloads/petty.mcpb" download="petty.mcpb" data-testid="token-addon">{t("tokens.addonDownload")}</a></p>
        <div className="actions">
          <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(made ?? "").then(() => toast(t("app.copied"))); }}>{t("app.copy")}</Button>
          <Button onClick={() => setMade(null)} data-testid="token-done">{t("app.done")}</Button>
        </div>
      </Sheet>

      <ConfirmSheet open={!!revoking} title={t("tokens.revoke")} body={t("tokens.revokeBody", { name: revoking?.name ?? "" })} confirmLabel={t("tokens.revoke")}
        onClose={() => setRevoking(null)}
        onConfirm={async () => { if (revoking) { await revokeAccessToken(revoking.id); reload(); } }} />
    </section>
  );
}
