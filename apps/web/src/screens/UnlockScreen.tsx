import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { isClerk } from "../lib/authConfig.js";
import { useNavigate } from "react-router";
import { WrongPassphrase } from "@petty/crypto";
import { Button } from "../components/Button.js";
import { Sheet } from "../components/Sheet.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { ApiError } from "../lib/api.js";
import { addPasskey, recoverWithCode } from "../lib/custody.js";
import { checkPassphrase } from "../lib/passphrase.js";
import { signOut, unlock, unlockWithPasskey, updateMe, updateVault, useAuth, type PasskeyUnlock } from "../lib/session.js";
import { deviceLabel, knownPasskeyIds, PasskeyError, passkeyPrfSupported, rememberPasskey } from "../lib/passkey.js";
import { offerToSavePassphrase, vaultUsername } from "../lib/credentials.js";
import { afterUnlock } from "../lib/afterUnlock.js";

/**
 * Passkey first (PETTY-102): the passkey button leads when the account has any; the passphrase
 * form follows when the account has a passphrase copy; the recovery code is the last door. After
 * an unlock through a passkey this device does not know (the phone's, via the QR code, on a new
 * laptop), a one-time sheet offers to add a passkey for this device while the keys are still open.
 */
export function UnlockScreen() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const auth = useAuth();
  const me = auth.status === "locked" || auth.status === "unlocked" ? auth.me : null;
  const [recover, setRecover] = useState(false);
  const [code, setCode] = useState("");
  const [np, setNp] = useState(""); const [np2, setNp2] = useState(""); const [lp, setLp] = useState("");
  const [rErr, setRErr] = useState<Record<string, string>>({});
  const [pkAvail, setPkAvail] = useState(false);
  const [pkBusy, setPkBusy] = useState(false);
  const [pkErr, setPkErr] = useState<string | null>(null);
  const [offer, setOffer] = useState<PasskeyUnlock | null>(null);
  const [label, setLabel] = useState(() => deviceLabel() ?? "");
  const [oLp, setOLp] = useState("");
  const [oErr, setOErr] = useState<string | null>(null);
  const [oBusy, setOBusy] = useState(false);
  useEffect(() => { void passkeyPrfSupported().then(setPkAvail); }, []);
  const hasPasskey = !!me?.passkeys.length;
  const hasPassphrase = !!me?.vault;

  async function doPasskey() {
    setPkBusy(true); setPkErr(null);
    try {
      const r = await unlockWithPasskey({ hold: true });
      if (r.extractable && !knownPasskeyIds().includes(r.credential_id)) { setOffer(r); return; }
      await r.open();
      nav(afterUnlock() ?? "/", { replace: true });
    } catch (err) {
      if (err instanceof PasskeyError) setPkErr(err.code === "cancelled" ? null : t(hasPassphrase ? "auth.unlock.passkeyNoPrf" : "auth.unlock.passkeyNoPrfNoPassphrase"));
      else if (err instanceof WrongPassphrase) setPkErr(t("auth.unlock.passkeyWrong"));
      else setPkErr(t("errors.unknown"));
    } finally { setPkBusy(false); }
  }

  async function declineOffer() {
    if (!offer) return;
    rememberPasskey(offer.credential_id);
    setOffer(null);
    await offer.open();
    nav(afterUnlock() ?? "/", { replace: true });
  }
  async function acceptOffer(e: FormEvent) {
    e.preventDefault();
    if (!offer?.extractable || !me) return;
    setOBusy(true); setOErr(null);
    try {
      const entry = await addPasskey(me, offer.extractable, label || t("settings.passkey.thisDevice"), isClerk() ? undefined : oLp);
      await updateMe({ passkeys: [...me.passkeys, entry] });
      rememberPasskey(offer.credential_id);
      toast(t("settings.passkey.added"));
      setOffer(null);
      await offer.open();
      nav(afterUnlock() ?? "/", { replace: true });
    } catch (err) {
      if (err instanceof PasskeyError && err.code === "cancelled") setOErr(t("settings.passkey.cancelled"));
      else if (err instanceof PasskeyError) setOErr(t(err.code === "exists" ? "settings.passkey.exists" : err.code === "no_prf" ? "settings.passkey.noPrf" : "settings.passkey.unsupported"));
      else if (err instanceof ApiError && err.status === 401) setOErr(t("auth.login.failed"));
      else setOErr(t("errors.unknown"));
    } finally { setOBusy(false); }
  }

  async function doRecover(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    const errs: Record<string, string> = {};
    const p = checkPassphrase(np, lp, me.email);
    if (p === "short") errs["np"] = t("auth.join.errors.passphraseShort"); else if (p === "same_as_password") errs["np"] = t("auth.join.errors.passphraseSame"); else if (p === "weak") errs["np"] = t("auth.join.errors.passphraseWeak");
    if (np !== np2) errs["np2"] = t("auth.join.errors.passphraseMismatch");
    setRErr(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const vault = await recoverWithCode(code, np, isClerk() ? undefined : lp);
      await updateVault(vault);
      void offerToSavePassphrase(me.email, np);
      toast(t(hasPassphrase ? "auth.unlock.recoverDone" : "auth.unlock.recoverSet"));
      setRecover(false); setPassphrase("");
    } catch (err) {
      if (err instanceof WrongPassphrase) setRErr({ code: t("auth.unlock.recoverWrong") });
      else if (err instanceof ApiError && err.status === 401) setRErr({ lp: t("auth.login.failed") });
      else setRErr({ code: t("errors.unknown") });
    } finally { setBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await unlock(passphrase);
      nav(afterUnlock() ?? "/", { replace: true });
    } catch (err) {
      setError(err instanceof WrongPassphrase ? t("auth.unlock.wrong") : t("errors.unknown"));
    } finally { setBusy(false); }
  }

  const passkeyFirst = hasPasskey && pkAvail;
  return (
    <>
      <TopBar title={t("auth.unlock.title")} />
      <main>
        {me ? <p className="hint">{t("settings.signedInAs", { email: me.email })}</p> : null}
        {passkeyFirst ? (
          <div className="mb12" data-testid="unlock-passkey-block">
            <Button variant="primary" onClick={() => { void doPasskey(); }} busy={pkBusy} data-testid="unlock-passkey">{t("auth.unlock.passkey")}</Button>
            <p className="hint mt6">{t("auth.unlock.passkeyHint")}</p>
            {pkErr ? <p className="error" role="alert">{pkErr}</p> : null}
          </div>
        ) : null}
        {hasPasskey && !pkAvail ? <p className="hint">{t("auth.unlock.passkeyUnsupported")}</p> : null}
        {hasPassphrase ? (
          <form onSubmit={submit} noValidate>
            {passkeyFirst ? <p className="hint mb6">{t("auth.unlock.orPassphrase")}</p> : null}
            {/* Hidden username so password managers file the passphrase as its own credential for this site. */}
            <input type="text" name="username" autoComplete="username" value={me ? vaultUsername(me.email) : ""} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" data-testid="vault-username" />
            <TextField label={t("auth.unlock.passphrase")} type="password" name="vault-passphrase" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} error={error} hint={t("auth.unlock.managerHint")} autoFocus={!passkeyFirst} />
            <Button type="submit" variant={passkeyFirst ? "secondary" : "primary"} busy={busy}>{busy ? t("auth.unlock.working") : t("auth.unlock.submit")}</Button>
          </form>
        ) : null}
        <p><Button variant="ghost" onClick={() => { setRecover(true); setRErr({}); }}>{t(hasPassphrase ? "auth.unlock.useRecovery" : "auth.unlock.useRecoveryNoPassphrase")}</Button></p>
        <p><Button variant="ghost" onClick={() => { void signOut().then(() => nav("/", { replace: true })); }}>{t("auth.unlock.signOut")}</Button></p>
      </main>
      <Sheet open={recover} title={t("auth.unlock.recoveryTitle")} onClose={() => setRecover(false)}>
        <form onSubmit={doRecover} noValidate>
          {hasPassphrase ? null : <p className="hint mb12">{t("auth.unlock.recoverSetsPassphrase")}</p>}
          <TextField label={t("auth.unlock.recoveryCode")} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} error={rErr["code"]} autoFocus />
          <input type="text" name="username" autoComplete="username" value={me ? vaultUsername(me.email) : ""} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
          <TextField label={t("auth.unlock.newPassphrase")} type="password" name="vault-passphrase" autoComplete="new-password" value={np} onChange={(e) => setNp(e.target.value)} hint={t("auth.join.passphraseHint")} error={rErr["np"]} />
          <TextField label={t("auth.unlock.newPassphraseRepeat")} type="password" autoComplete="new-password" value={np2} onChange={(e) => setNp2(e.target.value)} error={rErr["np2"]} />
          {isClerk() ? null : <TextField label={t("auth.unlock.loginPassword")} type="password" autoComplete="current-password" value={lp} onChange={(e) => setLp(e.target.value)} error={rErr["lp"]} />}
          <div className="actions">
            <Button variant="secondary" onClick={() => setRecover(false)}>{t("app.cancel")}</Button>
            <Button type="submit" busy={busy}>{t("auth.unlock.recover")}</Button>
          </div>
        </form>
      </Sheet>
      <Sheet open={!!offer} title={t("auth.unlock.addHereTitle")} onClose={() => { void declineOffer(); }}>
        <form onSubmit={acceptOffer} noValidate data-testid="add-here-form">
          <p className="hint mb12">{t("auth.unlock.addHereBody")}</p>
          <TextField label={t("settings.passkey.label")} value={label} onChange={(e) => setLabel(e.target.value)} hint={t("settings.passkey.labelHint")} autoComplete="off" />
          {isClerk() ? null : <TextField label={t("auth.unlock.loginPassword")} type="password" autoComplete="current-password" value={oLp} onChange={(e) => setOLp(e.target.value)} />}
          {oErr ? <p className="error" role="alert">{oErr}</p> : null}
          <div className="actions">
            <Button variant="secondary" onClick={() => { void declineOffer(); }}>{t("auth.unlock.notNow")}</Button>
            <Button type="submit" busy={oBusy}>{t("auth.unlock.addHere")}</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
