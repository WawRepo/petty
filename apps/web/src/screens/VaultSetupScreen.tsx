import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
import type { Me } from "@petty/protocol";
import { Button } from "../components/Button.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { FirstDoorFields, RecoveryCodeStep, useFirstDoor, validateFirstDoor } from "../components/VaultCreate.js";
import { api, ApiError, NetworkError } from "../lib/api.js";
import { PasskeyError, rememberPasskey } from "../lib/passkey.js";
import { afterLogin, unlockWithKeys, useAuth } from "../lib/session.js";
import { createVaultMaterial } from "../lib/vaultCreate.js";

type Step = { kind: "form" } | { kind: "recovery"; code: string };

/**
 * Clerk mode (PETTY-88): the identity exists, the vault does not. Passkey first (PETTY-102): keys
 * are generated and wrapped here under a passkey on this device (or a passphrase on request) and
 * the recovery code, the server stores what it cannot open, then the recovery code must be typed
 * back once.
 */
export function VaultSetupScreen() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [name, setName] = useState("");
  const [door, setDoor, pkAvail] = useFirstDoor();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const auth = useAuth();

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = validateFirstDoor(door, t, "", "");
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const m = await createVaultMaterial(door.method === "passkey"
        ? { kind: "passkey", email: t("auth.setup.passkeyAccount"), displayName: name.trim() || t("auth.setup.passkeyAccount"), label: door.label || t("settings.passkey.thisDevice") }
        : { kind: "passphrase", passphrase: door.passphrase });
      const me = await api<Me>("POST", "/auth/provision", { ...(name.trim() ? { display_name: name.trim() } : {}), locale: i18n.language === "pl" ? "pl" : "en", ...m.body });
      if (m.body.passkey) rememberPasskey(m.body.passkey.credential_id);
      await afterLogin(me);
      await unlockWithKeys(m.keys);
      setStep({ kind: "recovery", code: m.recoveryCode });
    } catch (err) {
      if (err instanceof PasskeyError) setErrors({ form: err.code === "cancelled" ? t("settings.passkey.cancelled") : t(err.code === "no_prf" ? "settings.passkey.noPrf" : "settings.passkey.unsupported") });
      else setErrors({ form: err instanceof NetworkError ? t("errors.network") : err instanceof ApiError && err.code === "AlreadyProvisioned" ? t("auth.setup.already") : t("errors.unknown") });
    } finally { setBusy(false); }
  }

  if (step.kind === "recovery") return <RecoveryCodeStep code={step.code} onDone={() => nav("/", { replace: true })} />;
  // a vault that exists, with no code waiting to be confirmed, has nothing to set up here (PETTY-199)
  if (auth.status !== "novault" && !busy) return <Navigate to="/" replace />;
  return (
    <>
      <TopBar title={t("auth.setup.title")} />
      <main>
        <section className="card mb16" data-testid="setup-explainer">
          <h2 className="h-card">{t("auth.join.explainer.title")}</h2>
          <ol className="list m0 fs13">
            <li className="mb6">{t("auth.setup.explainer.identity")}</li>
            <li className="mb6">{t(door.method === "passkey" ? "auth.join.explainer.passkey" : "auth.join.explainer.passphrase")}</li>
            <li>{t("auth.join.explainer.recovery")}</li>
          </ol>
        </section>
        <form onSubmit={submit} noValidate>
          <TextField label={t("auth.setup.displayName")} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" hint={t("auth.setup.displayNameHint")} />
          <FirstDoorFields state={door} set={setDoor} pkAvail={pkAvail} errors={errors} />
          {errors["form"] ? <p className="error" role="alert">{errors["form"]}</p> : null}
          <Button type="submit" busy={busy}>{busy ? t("auth.join.working") : t(door.method === "passkey" ? "auth.join.submitPasskey" : "auth.setup.submit")}</Button>
        </form>
      </main>
    </>
  );
}
