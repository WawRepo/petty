import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { normalizeRecoveryCode } from "@petty/crypto";
import { Button } from "./Button.js";
import { TextField } from "./TextField.js";
import { TopBar } from "./TopBar.js";
import { deviceLabel, passkeyAvailable, passkeyPrfSupported } from "../lib/passkey.js";
import { checkPassphrase } from "../lib/passphrase.js";

export type DoorMethod = "passkey" | "passphrase";

/**
 * The first door of a new vault (PETTY-102): a passkey on this device where the browser can do
 * PRF, a passphrase otherwise or on request. Shared by the join screen (local mode) and the
 * setup screen (Clerk mode); the screens own the state, this renders the fields and the switch.
 */
export interface FirstDoorState { method: DoorMethod; label: string; passphrase: string; passphrase2: string }
/** Returns the state, a setter, and whether a passkey is possible here (null until the browser answered — the fields wait for it, so nothing flips under the user's fingers). */
export function useFirstDoor(): [FirstDoorState, (patch: Partial<FirstDoorState>) => void, boolean | null] {
  const [pkAvail, setPkAvail] = useState<boolean | null>(null);
  const [state, setState] = useState<FirstDoorState>({ method: passkeyAvailable() ? "passkey" : "passphrase", label: deviceLabel() ?? "", passphrase: "", passphrase2: "" });
  useEffect(() => {
    void passkeyPrfSupported().then((ok) => { setPkAvail(ok); setState((s) => ({ ...s, method: ok ? s.method : "passphrase" })); });
  }, []);
  return [state, (patch) => setState((s) => ({ ...s, ...patch })), pkAvail];
}

/** Errors keyed like the fields; empty when fine. */
export function validateFirstDoor(s: FirstDoorState, t: (k: string) => string, loginPassword: string, email: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (s.method === "passphrase") {
    const p = checkPassphrase(s.passphrase, loginPassword, email);
    if (p === "short") e["passphrase"] = t("auth.join.errors.passphraseShort");
    else if (p === "same_as_password") e["passphrase"] = t("auth.join.errors.passphraseSame");
    else if (p === "weak") e["passphrase"] = t("auth.join.errors.passphraseWeak");
    if (s.passphrase !== s.passphrase2) e["passphrase2"] = t("auth.join.errors.passphraseMismatch");
  }
  return e;
}

export function FirstDoorFields({ state, set, pkAvail, errors }: { state: FirstDoorState; set: (p: Partial<FirstDoorState>) => void; pkAvail: boolean | null; errors: Record<string, string> }) {
  const { t } = useTranslation();
  if (pkAvail === null) return <p className="hint" data-testid="door-pending">{t("app.loading")}</p>;
  if (state.method === "passkey") {
    return (
      <div data-testid="door-passkey">
        <p className="hint mb8">{t("auth.join.passkeyHint")}</p>
        <TextField label={t("settings.passkey.label")} value={state.label} onChange={(e) => set({ label: e.target.value })} hint={t("settings.passkey.labelHint")} autoComplete="off" />
        <p className="mt4"><Button variant="ghost" onClick={() => set({ method: "passphrase" })} data-testid="door-use-passphrase">{t("auth.join.usePassphrase")}</Button></p>
      </div>
    );
  }
  return (
    <div data-testid="door-passphrase">
      <TextField label={t("auth.join.passphrase")} type="password" autoComplete="new-password" value={state.passphrase} onChange={(e) => set({ passphrase: e.target.value })} hint={t("auth.join.passphraseHint")} error={errors["passphrase"]} />
      <TextField label={t("auth.join.passphraseRepeat")} type="password" autoComplete="new-password" value={state.passphrase2} onChange={(e) => set({ passphrase2: e.target.value })} error={errors["passphrase2"]} />
      {pkAvail ? <p className="mt4"><Button variant="ghost" onClick={() => set({ method: "passkey" })} data-testid="door-use-passkey">{t("auth.join.usePasskey")}</Button></p> : null}
    </div>
  );
}

/** The recovery code, shown once and typed back. */
export function RecoveryCodeStep({ code, onDone }: { code: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  function confirm(ev: FormEvent) {
    ev.preventDefault();
    if (normalizeRecoveryCode(typed) !== normalizeRecoveryCode(code)) { setError(t("auth.recovery.mismatch")); return; }
    onDone();
  }
  return (
    <>
      <TopBar title={t("auth.recovery.title")} />
      <main>
        <p>{t("auth.recovery.body")}</p>
        <p className="code" data-testid="recovery-code">{code}</p>
        <form onSubmit={confirm} noValidate>
          <TextField label={t("auth.recovery.confirmLabel")} value={typed} onChange={(e) => { setTyped(e.target.value); setError(null); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} error={error} />
          <Button type="submit">{t("auth.recovery.done")}</Button>
        </form>
      </main>
    </>
  );
}
