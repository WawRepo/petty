import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { openSignup } from "../lib/authConfig.js";
import type { Me } from "@petty/protocol";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { FirstDoorFields, RecoveryCodeStep, useFirstDoor, validateFirstDoor } from "../components/VaultCreate.js";
import { api, ApiError, NetworkError } from "../lib/api.js";
import { PasskeyError, rememberPasskey } from "../lib/passkey.js";
import { afterLogin, unlockWithKeys } from "../lib/session.js";
import { offerToSavePassphrase } from "../lib/credentials.js";
import { createVaultMaterial } from "../lib/vaultCreate.js";

const Info = z.object({ valid: z.boolean(), inviter_name: z.string().nullable(), email: z.string().nullable() });

type Step = { kind: "form" } | { kind: "recovery"; code: string };

/** Two screens: the form (keys are generated and wrapped in the browser — under a passkey first, PETTY-102), then the recovery code that must be typed back once. */
export function JoinScreen() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const { token: pathToken } = useParams();
  const [token] = useState(() => pathToken ?? location.hash.replace(/^#/, ""));
  const [info, setInfo] = useState<z.infer<typeof Info> | null>(null);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [door, setDoor, pkAvail] = useFirstDoor();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // PETTY-215: open signup has no join link — show the form directly instead of looking one up.
    if (!token) { setInfo(openSignup() ? { valid: true, inviter_name: null, email: null } : { valid: false, inviter_name: null, email: null }); return; }
    api("GET", `/join-links/${encodeURIComponent(token)}`).then((r) => { const i = Info.parse(r); setInfo(i); if (i.email) setEmail(i.email); }).catch(() => setInfo({ valid: false, inviter_name: null, email: null }));
  }, [token]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = validateFirstDoor(door, t, password, email);
    if (password.length < 8) e["password"] = t("auth.join.errors.passwordShort");
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      // Keys exist extractable only inside createVaultMaterial and unlockWithKeys; the session holds a non-extractable copy.
      const m = await createVaultMaterial(door.method === "passkey"
        ? { kind: "passkey", email, displayName: name, label: door.label || t("settings.passkey.thisDevice") }
        : { kind: "passphrase", passphrase: door.passphrase });
      const me = await api<Me>("POST", "/auth/signup", { ...(token ? { join_token: token } : {}), email, password, display_name: name, locale: i18n.language === "pl" ? "pl" : "en", ...m.body });
      if (m.body.passkey) rememberPasskey(m.body.passkey.credential_id);
      await afterLogin(me);
      await unlockWithKeys(m.keys);
      if (door.method === "passphrase") void offerToSavePassphrase(email, door.passphrase);
      setStep({ kind: "recovery", code: m.recoveryCode });
    } catch (err) {
      const e2: Record<string, string> = {};
      if (err instanceof PasskeyError) e2["form"] = err.code === "cancelled" ? t("settings.passkey.cancelled") : t(err.code === "no_prf" ? "settings.passkey.noPrf" : "settings.passkey.unsupported");
      else if (err instanceof ApiError && err.code === "EmailTaken") e2["email"] = t("auth.join.errors.emailTaken");
      else if (err instanceof ApiError && err.code === "JoinLinkEmailMismatch") e2["email"] = t("auth.join.errors.linkMismatch");
      else if (err instanceof ApiError && (err.code === "JoinLinkInvalid")) e2["form"] = t("auth.join.invalid");
      else if (err instanceof NetworkError) e2["form"] = t("errors.network");
      else e2["form"] = t("errors.unknown");
      setErrors(e2);
    } finally { setBusy(false); }
  }

  if (info === null) return <><TopBar title={t("auth.join.title")} /><main><p className="empty">{t("app.loading")}</p></main></>;
  // PETTY-128 (audit F21): a dead link still leads somewhere — a new link, sign in, or what Petty is.
  if (!info.valid) return (
    <>
      <TopBar title={t("auth.join.title")} onBack={() => nav("/")} />
      <main>
        <p className="error" role="alert">{t("auth.join.invalid")}</p>
        <p className="hint">{t("auth.join.invalidHint")}</p>
        <section className="card" data-testid="join-invalid-next">
          <p className="hint m0 mb8">{t("auth.join.haveAccount")}</p>
          <div className="actions m0">
            <Button onClick={() => nav("/login")}>{t("auth.login.submit")}</Button>
            <Button variant="secondary" onClick={() => nav("/")}>{t("auth.login.about")}</Button>
          </div>
        </section>
      </main>
    </>
  );
  if (step.kind === "recovery") return <RecoveryCodeStep code={step.code} onDone={() => nav("/", { replace: true })} />;

  return (
    <>
      <TopBar title={t("auth.join.title")} />
      <main>
        {info.inviter_name ? <p className="hint">{t("auth.join.invitedBy", { name: info.inviter_name })}</p> : null}
        <section className="card mb16" data-testid="join-explainer">
          <h2 className="h-card">{t("auth.join.explainer.title")}</h2>
          <ol className="list m0 fs13">
            <li className="mb6">{t("auth.join.explainer.password")}</li>
            <li className="mb6">{t(door.method === "passkey" ? "auth.join.explainer.passkey" : "auth.join.explainer.passphrase")}</li>
            <li>{t("auth.join.explainer.recovery")}</li>
          </ol>
        </section>
        <form onSubmit={submit} noValidate>
          <TextField label={t("auth.join.displayName")} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          <TextField label={t("auth.join.email")} type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required readOnly={!!info.email} error={errors["email"]} />
          <TextField label={t("auth.join.password")} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint={t("auth.join.passwordHint")} error={errors["password"]} />
          <FirstDoorFields state={door} set={setDoor} pkAvail={pkAvail} errors={errors} />
          {errors["form"] ? <p className="error" role="alert">{errors["form"]}</p> : null}
          <Button type="submit" busy={busy}>{busy ? t("auth.join.working") : t(door.method === "passkey" ? "auth.join.submitPasskey" : "auth.join.submit")}</Button>
        </form>
      </main>
    </>
  );
}
