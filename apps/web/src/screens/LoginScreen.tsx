import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { Me } from "@petty/protocol";
import { Button } from "../components/Button.js";
import { Sheet } from "../components/Sheet.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { api, ApiError, NetworkError } from "../lib/api.js";
import { afterLogin } from "../lib/session.js";
import { contactEmail } from "../lib/authConfig.js";


export function LoginScreen() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetErr, setResetErr] = useState<string | null>(null);
  async function sendReset(e: FormEvent) {
    e.preventDefault();
    if (!resetEmail.includes("@")) { setResetErr(t("auth.reset.emailInvalid")); return; }
    setResetBusy(true); setResetErr(null);
    try { await api("POST", "/auth/forgot", { email: resetEmail }); setResetSent(true); }
    catch (err) { setResetErr(err instanceof ApiError && err.status === 429 ? t("auth.login.tooMany") : err instanceof NetworkError ? t("errors.network") : t("errors.unknown")); }
    finally { setResetBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await afterLogin(await api<Me>("POST", "/auth/login", { email, password }));
      nav("/unlock", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError(t("auth.login.tooMany"));
      else if (err instanceof ApiError) setError(t("auth.login.failed"));
      else if (err instanceof NetworkError) setError(t("errors.network"));
      else setError(t("errors.unknown"));
    } finally { setBusy(false); }
  }

  return (
    <>
      <TopBar title={t("auth.login.title")} onBack={() => nav("/")} />
      <main>
        <form onSubmit={submit} noValidate>
          <TextField label={t("auth.login.email")} type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <TextField label={t("auth.login.password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required error={error} />
          <Button type="submit" busy={busy}>{t("auth.login.submit")}</Button>
        </form>
        <p><Button variant="ghost" onClick={() => { setResetEmail(email); setReset(true); }}>{t("auth.login.forgot")}</Button></p>
        {/* PETTY-111 (audit F4): a visitor without an account gets a way out, not a dead sentence. */}
        <section className="card mt12" data-testid="login-no-account">
          <p className="hint m0 mb8">{t("auth.login.noAccount")}</p>
          <div className="actions m0">
            {contactEmail() ? <a className="btn btn-secondary" href={`mailto:${contactEmail()}?subject=Petty%20invite`}>{t("landing.getInvite")}</a> : null}
            <Button variant="ghost" onClick={() => nav("/")}>{t("auth.login.about")}</Button>
          </div>
        </section>
        <p><Button variant="ghost" onClick={() => nav("/privacy")}>{t("privacy.link")}</Button></p>
      </main>
      <Sheet open={reset} title={t("auth.reset.title")} onClose={() => { setReset(false); setResetSent(false); }}>
        <p className="hint">{t("auth.reset.body")}</p>
        {resetSent ? (
          <>
            <p role="status" data-testid="reset-sent">{t("auth.reset.sent")}</p>
            <div className="actions"><Button variant="secondary" onClick={() => { setReset(false); setResetSent(false); }}>{t("auth.reset.ok")}</Button></div>
          </>
        ) : (
          <form onSubmit={sendReset} noValidate>
            <TextField label={t("auth.login.email")} type="email" inputMode="email" autoComplete="username" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} error={resetErr} />
            <div className="actions">
              <Button variant="secondary" onClick={() => setReset(false)}>{t("app.cancel")}</Button>
              <Button type="submit" busy={resetBusy}>{t("auth.reset.send")}</Button>
            </div>
          </form>
        )}
      </Sheet>
    </>
  );
}
