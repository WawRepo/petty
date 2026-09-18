import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Me } from "@petty/protocol";
import { WrongPassphrase } from "@petty/crypto";
import { createAccessToken, revokeAccessToken, useAccessTokens } from "../lib/accessTokens.js";
import { openWithPasskey, openWithPassphrase } from "../lib/custody.js";
import { relativeTime } from "../lib/time.js";
import { Button } from "./Button.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { Sheet } from "./Sheet.js";
import { SwitchRow } from "./SwitchRow.js";
import { TextField } from "./TextField.js";
import { useToast } from "./Toast.js";

const DAYS = [30, 90, 365, 0] as const;
/** What a tool needs as PETTY_API_URL: this very origin, where the app and its API live together. */
const apiAddress = `${location.origin}/api`;

/**
 * Settings → access tokens (PETTY-164). The owner makes a token for their own tools, for example
 * a Claude Desktop server. A token that may add entries carries the signing key, so the vault is
 * opened here first: the passkey prompt or the passphrase is that confirmation.
 */
export function AccessTokens({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { tokens, reload } = useAccessTokens(true);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(true);
  const [days, setDays] = useState<number>(90);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  const close = () => { setOpen(false); setName(""); setPass(""); setError(null); setWrite(true); setDays(90); };

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const unlocked = write ? (me.vault && pass ? await openWithPassphrase(me, pass) : await openWithPasskey(me)) : undefined;
      const made = await createAccessToken({
        name: name.trim() || t("tokens.defaultName"),
        role: write ? "write" : "read",
        scope: null,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        ...(unlocked ? { unlocked } : {}),
      });
      setMade(made.token);
      close();
      reload();
    } catch (e) {
      setError(e instanceof WrongPassphrase ? t("auth.unlock.wrong") : t("errors.unknown"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="tokens-section">
      <h2 className="h-card">{t("tokens.title")}</h2>
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
        <div className="field mt12">
          <label htmlFor="token-expiry">{t("tokens.expiry")}</label>
          <select id="token-expiry" value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="token-expiry">
            {DAYS.map((d) => <option key={d} value={d}>{d ? t("tokens.days", { count: d }) : t("tokens.never")}</option>)}
          </select>
        </div>
        {write && me.vault ? (
          <TextField label={t("auth.unlock.passphrase")} type="password" autoComplete="current-password" value={pass} data-testid="token-passphrase"
            hint={me.passkeys.length ? t("tokens.passphraseOrPasskey") : undefined} onChange={(e) => setPass(e.target.value)} />
        ) : null}
        {error ? <div className="error" role="alert">{error}</div> : null}
        <div className="actions">
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
