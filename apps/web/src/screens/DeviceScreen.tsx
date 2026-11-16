import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { DeviceRequestView, type DeviceRequestView as Request } from "@petty/protocol";
import { deviceUserCode, normalizeDeviceCode, sealDeviceToken, WrongPassphrase } from "@petty/crypto";
import { CodeText } from "../components/CodeText.js";
import { Button } from "../components/Button.js";
import { SwitchRow } from "../components/SwitchRow.js";
import { TextField } from "../components/TextField.js";
import { scopeOf, TokenScope, type ScopeChoice } from "../components/TokenScope.js";
import { TopBar } from "../components/TopBar.js";
import { createAccessToken, revokeAccessToken } from "../lib/accessTokens.js";
import { clearAfterUnlock } from "../lib/afterUnlock.js";
import { api, ApiError } from "../lib/api.js";
import { loadIfIdle, useDrawers } from "../lib/drawers.js";
import { useBack } from "../lib/nav.js";
import { PasskeyError } from "../lib/passkey.js";
import { getAuth } from "../lib/session.js";
import { relativeTime } from "../lib/time.js";

const DAYS = [30, 90, 365, 0] as const;
type Phase = "enter" | "loading" | "ask" | "mismatch" | "done" | "denied";

/**
 * Device login (PETTY-274): `petty auth login` prints a code and opens this page, the way `gh auth
 * login` does. Signed in and unlocked, the person sees what asks and allows or denies it. Allowing makes
 * an ordinary access token here, as Settings → Access tokens does, and seals it to the tool's one-time
 * key: the server only relays the sealed token. The code is worked out again from the tool's key the
 * server passed on and from this page's own address (PETTY-451); if it differs, the request was changed
 * on its way, or the terminal was given another address, and it cannot be allowed. As in Settings
 * (PETTY-452), the person picks the drawers and opens the vault again, for a reading token too.
 */
export function DeviceScreen() {
  const { t, i18n } = useTranslation();
  const back = useBack("/");
  const [params] = useSearchParams();
  const drawers = useDrawers();
  const [typed, setTyped] = useState(params.get("code") ?? "");
  const [phase, setPhase] = useState<Phase>(normalizeDeviceCode(params.get("code") ?? "") ? "loading" : "enter");
  const [req, setReq] = useState<Request | null>(null);
  const [write, setWrite] = useState(true);
  const [days, setDays] = useState<number>(90);
  const [scope, setScope] = useState<ScopeChoice>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auth = getAuth();
  const me = auth.status === "unlocked" ? auth.me : null;

  useEffect(() => { clearAfterUnlock(); }, []);
  // the token copies the keys of the drawers this device has open, so they must be loaded first
  useEffect(() => { if (drawers.status === "idle") loadIfIdle(); }, [drawers.status]);

  async function look(code: string) {
    setPhase("loading");
    setError(null);
    try {
      const r = DeviceRequestView.parse(await api<unknown>("GET", `/device/${code}`));
      if (r.user_code !== code || (await deviceUserCode(r.cli_pub, location.origin)) !== code) { setPhase("mismatch"); return; }
      setReq(r);
      setWrite(r.role === "write");
      setDays(r.expires_days ?? 0);
      setPhase("ask");
    } catch (e) {
      setPhase("enter");
      setError(e instanceof ApiError && e.status === 404 ? t("device.unknown") : e instanceof ApiError && e.status === 429 ? t("device.tooMany") : t("errors.unknown"));
    }
  }
  useEffect(() => {
    const code = normalizeDeviceCode(params.get("code") ?? "");
    if (code) void look(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the code the terminal opened this page with
  }, []);

  function submitCode(e: FormEvent) {
    e.preventDefault();
    const code = normalizeDeviceCode(typed);
    if (!code) { setError(t("device.notACode")); return; }
    void look(code);
  }

  async function allow() {
    if (!req || !me) return;
    const chosen = scopeOf(scope);
    if (chosen === undefined) { setError(t("tokens.scopeNeeded")); return; }
    if (me.vault && !pass && !me.passkeys.length) { setError(t("tokens.passphraseNeeded")); return; }
    setBusy(true);
    setError(null);
    let madeId: string | null = null;
    try {
      const made = await createAccessToken({
        name: req.client_name,
        role: write ? "write" : "read",
        scope: chosen,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        passphrase: me.vault && pass ? pass : null,
      });
      madeId = made.row.id;
      const sealed = await sealDeviceToken(req.cli_pub, made.token, { requestId: req.id, userCode: req.user_code, origin: location.origin });
      await api("POST", `/device/${req.user_code}/approve`, { sealed });
      setPhase("done");
    } catch (e) {
      // a token the tool will never receive must not stay behind
      if (madeId) await revokeAccessToken(madeId).catch(() => undefined);
      if (e instanceof WrongPassphrase) setError(t("auth.unlock.wrong"));
      else if (e instanceof PasskeyError) setError(t(e.code === "cancelled" ? "settings.passkey.cancelled" : "settings.passkey.unsupported"));
      else if (e instanceof ApiError && e.status === 404) { setPhase("enter"); setError(t("device.unknown")); }
      else setError(t("errors.unknown"));
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    if (!req) return;
    setBusy(true);
    try {
      await api("POST", `/device/${req.user_code}/deny`);
      setPhase("denied");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setPhase("enter"); setError(t("device.unknown")); } else setError(t("errors.unknown"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title={t("device.title")} onBack={back} />
      <main className="stack" data-testid="device-screen">
        {/* PETTY-279: the form stays while a typed code is checked, and its field carries the error */}
        {phase === "enter" || (phase === "loading" && typed) ? (
          <form className="card" onSubmit={submitCode} noValidate>
            <p className="hint mt0"><CodeText text={t("device.enterBody")} /></p>
            <TextField label={t("device.code")} value={typed} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="BCDF-GHJK-LMNP-QRST-VWXZ"
              data-testid="device-code" onChange={(e) => { setTyped(e.target.value); setError(null); }} error={error ? <CodeText text={error} /> : null} />
            <div className="actions"><Button type="submit" busy={phase === "loading"} data-testid="device-continue">{t("device.continue")}</Button></div>
          </form>
        ) : null}

        {phase === "loading" && !typed ? <p className="hint" role="status">{t("device.checking")}</p> : null}

        {phase === "mismatch" ? <p className="warn-box danger" role="alert" data-testid="device-mismatch"><CodeText text={t("device.mismatch", { origin: location.origin })} /></p> : null}

        {phase === "ask" && req ? (
          <section className="card" data-testid="device-ask">
            <h2 className="h-card">{t("device.askTitle", { name: req.client_name })}</h2>
            <p className="hint m0">{t("device.checkCode")}</p>
            <p className="code" data-testid="device-shown-code">{req.user_code}</p>
            <p className="hint">{req.ip ? t("device.askedFrom", { when: relativeTime(req.created_at, i18n.language, t), ip: req.ip }) : t("device.asked", { when: relativeTime(req.created_at, i18n.language, t) })}</p>
            <p className="warn-box">{t("device.onlyYours")}</p>
            {req.role === "write" ? (
              <SwitchRow label={t("tokens.mayWriteSwitch")} hint={t("tokens.mayWriteHint")} checked={write} onChange={setWrite} testId="device-write" />
            ) : <p className="hint">{t("device.readOnly")}</p>}
            <TokenScope value={scope} onChange={(next) => { setScope(next); setError(null); }} testId="device-scope" />
            <div className="field mt12">
              <label htmlFor="device-expiry">{t("tokens.expiry")}</label>
              <select id="device-expiry" value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="device-expiry">
                {DAYS.map((d) => <option key={d} value={d}>{d ? t("tokens.days", { count: d }) : t("tokens.never")}</option>)}
              </select>
            </div>
            <p className="hint">{t("tokens.confirm")}</p>
            {me?.vault ? (
              <TextField label={t("auth.unlock.passphrase")} type="password" autoComplete="current-password" value={pass} data-testid="device-passphrase"
                hint={me.passkeys.length ? t("tokens.passphraseOrPasskey") : undefined} onChange={(e) => setPass(e.target.value)} />
            ) : null}
            {error ? <div className="error" role="alert">{error}</div> : null}
            <div className="actions">
              <Button variant="secondary" busy={busy} onClick={() => { void deny(); }} data-testid="device-deny">{t("device.deny")}</Button>
              <Button busy={busy} disabled={drawers.status !== "ready"} onClick={() => { void allow(); }} data-testid="device-allow">{t("device.allow")}</Button>
            </div>
          </section>
        ) : null}

        {phase === "done" ? (
          <section className="card" role="status" data-testid="device-done">
            <h2 className="h-card">{t("device.doneTitle")}</h2>
            <p className="hint m0">{t("device.doneBody")}</p>
            <div className="actions"><Link className="btn btn-secondary" to="/settings">{t("device.toSettings")}</Link></div>
          </section>
        ) : null}

        {phase === "denied" ? (
          <section className="card" role="status" data-testid="device-denied">
            <h2 className="h-card">{t("device.deniedTitle")}</h2>
            <p className="hint m0">{t("device.deniedBody")}</p>
            <div className="actions"><Link className="btn btn-secondary" to="/">{t("app.done")}</Link></div>
          </section>
        ) : null}
      </main>
    </>
  );
}
