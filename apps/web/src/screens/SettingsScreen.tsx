import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useBack } from "../lib/nav.js";
import { Button } from "../components/Button.js";
import { TopBar } from "../components/TopBar.js";
import { TagManager } from "../components/TagManager.js";
import { useToast } from "../components/Toast.js";
import { LanguagePicker } from "../components/LanguagePicker.js";
import { ThemePicker } from "../components/ThemePicker.js";
import { lockNow, mySafetyNumber, signOut, useAuth } from "../lib/session.js";
import { api } from "../lib/api.js";
import { BackupSection } from "../components/BackupSection.js";
import { AccessTokens } from "../components/AccessTokens.js";
import { Sheet } from "../components/Sheet.js";
import { SwitchRow } from "../components/SwitchRow.js";
import { TextField } from "../components/TextField.js";
import { addPasskey, changePassphrase, makeRecoveryCode, openWithPasskey, openWithPassphrase, removePasskey, setPassphrase, storeRecoveryCode } from "../lib/custody.js";
import { deviceLabel, PasskeyError, passkeyPrfSupported } from "../lib/passkey.js";
import type { PasskeyEntry, StorageUsage } from "@petty/protocol";
import { fetchStorage, formatMegabytes } from "../lib/storage.js";
import { updateMe } from "../lib/session.js";
import { checkPassphrase } from "../lib/passphrase.js";
import { normalizeRecoveryCode, WrongPassphrase, type UnlockedKeys, type VaultBlobV1 } from "@petty/crypto";
import { ApiError } from "../lib/api.js";
import { updateVault } from "../lib/session.js";
import { type FormEvent } from "react";
import { offerToSavePassphrase, vaultUsername } from "../lib/credentials.js";
import { promptInstall, useInstallState } from "../lib/install.js";
import { pictureShown, placesShown, setPictureShown, setPlacesShown, setTotalsShown, setVerificationShown, totalsShown, usePins, verificationShown } from "../lib/pins.js";
import { appVersion, isClerk } from "../lib/authConfig.js";

export function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const pinsDoc = usePins().doc;
  const showPlaces = placesShown(pinsDoc);
  const showVerification = verificationShown(pinsDoc);
  const showTotals = totalsShown(pinsDoc);
  const nav = useNavigate();
  const back = useBack("/");
  const auth = useAuth();
  const toast = useToast();
  const [safety, setSafety] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [joinLink, setJoinLink] = useState<string | null>(null);
  const [cp, setCp] = useState(false);
  const [cur, setCur] = useState(""); const [np, setNp] = useState(""); const [np2, setNp2] = useState(""); const [lp, setLp] = useState("");
  const [cErr, setCErr] = useState<Record<string, string>>({});
  const [cBusy, setCBusy] = useState(false);
  const [pkAvail, setPkAvail] = useState(false);
  const [pkAdd, setPkAdd] = useState(false); const [pkRemove, setPkRemove] = useState<PasskeyEntry | null>(null);
  const [pkPass, setPkPass] = useState(""); const [pkLp, setPkLp] = useState(""); const [pkLabel, setPkLabel] = useState(() => deviceLabel() ?? "");
  const [pkErr, setPkErr] = useState<Record<string, string>>({});
  const [pkBusy, setPkBusy] = useState(false);
  const [sp, setSp] = useState(false); // set a backup passphrase (passkey-only account)
  // PETTY-200: a new recovery code. Made after the vault is opened, stored only once typed back.
  const [rc, setRc] = useState(false);
  const [rcPass, setRcPass] = useState(""); const [rcLp, setRcLp] = useState(""); const [rcTyped, setRcTyped] = useState("");
  const [rcNew, setRcNew] = useState<{ code: string; vault: VaultBlobV1; unlocked: UnlockedKeys } | null>(null);
  const [rcErr, setRcErr] = useState<Record<string, string>>({}); const [rcBusy, setRcBusy] = useState(false);
  const closeRc = () => { setRc(false); setRcNew(null); setRcPass(""); setRcLp(""); setRcTyped(""); setRcErr({}); };
  async function doRecoveryOpen(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    setRcBusy(true); setRcErr({});
    try {
      const unlocked = me.vault ? await openWithPassphrase(me, rcPass) : await openWithPasskey(me);
      setRcNew({ ...(await makeRecoveryCode(unlocked)), unlocked });
    } catch (err) {
      setRcErr(err instanceof WrongPassphrase ? { pass: t("auth.unlock.wrong") } : passkeyMessage(err));
    } finally { setRcBusy(false); }
  }
  async function doRecoveryStore(e: FormEvent) {
    e.preventDefault();
    if (!rcNew) return;
    if (normalizeRecoveryCode(rcTyped) !== normalizeRecoveryCode(rcNew.code)) { setRcErr({ typed: t("auth.recovery.mismatch") }); return; }
    setRcBusy(true); setRcErr({});
    try {
      await storeRecoveryCode(rcNew.unlocked, rcNew.vault, isClerk() ? undefined : rcLp);
      toast(t("settings.recovery.saved"));
      closeRc();
    } catch (err) {
      setRcErr(err instanceof ApiError && err.status === 401 ? { lp: t("auth.login.failed") } : { typed: t("errors.unknown") });
    } finally { setRcBusy(false); }
  }
  useEffect(() => { void passkeyPrfSupported().then(setPkAvail); }, []);
  function passkeyMessage(err: unknown): Record<string, string> {
    if (err instanceof WrongPassphrase) return { pass: t("auth.unlock.wrong") };
    if (err instanceof ApiError && err.status === 401) return { lp: t("auth.login.failed") };
    if (err instanceof ApiError && err.code === "LastDoor") return { lp: t("settings.passkey.lastDoor") };
    if (err instanceof PasskeyError) return { lp: t(err.code === "cancelled" ? "settings.passkey.cancelled" : err.code === "exists" ? "settings.passkey.exists" : err.code === "no_prf" ? "settings.passkey.noPrf" : "settings.passkey.unsupported") };
    return { lp: t("errors.unknown") };
  }
  /** Adding a passkey needs the keys extractable: the passphrase proves it where one exists, otherwise an existing passkey does. */
  async function doPasskeyAdd(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    setPkBusy(true); setPkErr({});
    try {
      const unlocked = me.vault ? await openWithPassphrase(me, pkPass) : await openWithPasskey(me);
      const entry = await addPasskey(me, unlocked, pkLabel || t("settings.passkey.thisDevice"), isClerk() ? undefined : pkLp);
      await updateMe({ passkeys: [...me.passkeys, entry] });
      toast(t("settings.passkey.added"));
      setPkAdd(false); setPkPass(""); setPkLp("");
    } catch (err) { setPkErr(passkeyMessage(err)); } finally { setPkBusy(false); }
  }
  async function doPasskeyRemove(e: FormEvent) {
    e.preventDefault();
    if (!me || !pkRemove || auth.status !== "unlocked") return;
    setPkBusy(true); setPkErr({});
    try {
      await removePasskey(pkRemove.id, auth.keys.ecdsaPrivate, isClerk() ? undefined : pkLp);
      await updateMe({ passkeys: me.passkeys.filter((p) => p.id !== pkRemove.id) });
      toast(t("settings.passkey.removed"));
      setPkRemove(null); setPkLp("");
    } catch (err) { setPkErr(passkeyMessage(err)); } finally { setPkBusy(false); }
  }
  /** Passkey-only account: a first (backup) passphrase, confirmed by an existing passkey. */
  async function doSetPassphrase(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    const errs: Record<string, string> = {};
    const p = checkPassphrase(np, lp, me.email);
    if (p === "short") errs["np"] = t("auth.join.errors.passphraseShort"); else if (p === "same_as_password") errs["np"] = t("auth.join.errors.passphraseSame"); else if (p === "weak") errs["np"] = t("auth.join.errors.passphraseWeak");
    if (np !== np2) errs["np2"] = t("auth.join.errors.passphraseMismatch");
    setCErr(errs);
    if (Object.keys(errs).length) return;
    setCBusy(true);
    try {
      const vault = await setPassphrase(await openWithPasskey(me), np, isClerk() ? undefined : lp);
      await updateVault(vault);
      void offerToSavePassphrase(me.email, np);
      toast(t("settings.passphraseSet"));
      setSp(false); setNp(""); setNp2(""); setLp("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setCErr({ lp: t("auth.login.failed") });
      else if (err instanceof PasskeyError) setCErr({ np: t(err.code === "cancelled" ? "settings.passkey.cancelled" : "settings.passkey.unsupported") });
      else setCErr({ np: t("errors.unknown") });
    } finally { setCBusy(false); }
  }
  async function doChange(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    const errs: Record<string, string> = {};
    const p = checkPassphrase(np, lp, me.email);
    if (p === "short") errs["np"] = t("auth.join.errors.passphraseShort"); else if (p === "same_as_password") errs["np"] = t("auth.join.errors.passphraseSame"); else if (p === "weak") errs["np"] = t("auth.join.errors.passphraseWeak");
    if (np !== np2) errs["np2"] = t("auth.join.errors.passphraseMismatch");
    setCErr(errs);
    if (Object.keys(errs).length) return;
    setCBusy(true);
    try {
      const vault = await changePassphrase(me, cur, np, isClerk() ? undefined : lp);
      await updateVault(vault);
      void offerToSavePassphrase(me.email, np);
      toast(t("settings.passphraseChanged"));
      setCp(false); setCur(""); setNp(""); setNp2(""); setLp("");
    } catch (err) {
      if (err instanceof WrongPassphrase) setCErr({ cur: t("auth.unlock.wrong") });
      else if (err instanceof ApiError && err.status === 401) setCErr({ lp: t("auth.login.failed") });
      else setCErr({ cur: t("errors.unknown") });
    } finally { setCBusy(false); }
  }
  const me = auth.status === "unlocked" || auth.status === "locked" ? auth.me : null;
  useEffect(() => { if (me) void mySafetyNumber(me).then(setSafety); }, [me]);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  useEffect(() => { if (auth.status === "unlocked") void fetchStorage().then(setStorage).catch(() => setStorage(null)); }, [auth.status]);
  const install = useInstallState();

  return (
    <>
      <TopBar title={t("settings.title")} onBack={back} />
      <main className="stack">
        <section className="card">
          {/* PETTY-249: the choice is also stored on the account, so emails come in this language */}
          <LanguagePicker testId="settings-language" onPick={(l) => { void api("PATCH", "/me", { locale: l }).then(() => updateMe({ locale: l })).catch(() => undefined); }} />
          <ThemePicker testId="settings-theme" />
        </section>
        <section className="card" data-testid="home-section">
          <h2 className="h-card">{t("settings.home.title")}</h2>
          <SwitchRow label={t("settings.home.places")} hint={t("settings.home.placesHint")} checked={showPlaces} onChange={(v) => { void setPlacesShown(v); }} testId="places-switch" />
          <SwitchRow className="mt8" label={t("settings.home.verification")} hint={t("settings.home.verificationHint")} checked={showVerification} onChange={(v) => { void setVerificationShown(v); }} testId="verification-switch" />
          <SwitchRow className="mt8" label={t("settings.home.totals")} hint={t("settings.home.totalsHint")} checked={showTotals} onChange={(v) => { void setTotalsShown(v); }} testId="totals-switch" />
          <SwitchRow className="mt8" label={t("settings.home.picture")} hint={t("settings.home.pictureHint")} checked={pictureShown(pinsDoc)} onChange={(v) => { void setPictureShown(v); }} testId="picture-switch" />
          <p className="hint my6">{t("places.manageHint")}</p>
          <Button variant="secondary" onClick={() => nav("/places")} data-testid="manage-places">{t("places.manage")}</Button>
          <p className="hint my6">{t("drawer.tagsManageHint")}</p>
          <Button variant="secondary" onClick={() => setTagsOpen(true)} data-testid="settings-manage-tags">{t("drawer.tagsManage")}</Button>
          <TagManager open={tagsOpen} onClose={() => setTagsOpen(false)} />
        </section>
        {me && auth.status === "unlocked" ? <AccessTokens me={me} /> : null}
        <BackupSection />
        {storage?.quota_bytes ? (
          <section className="card" data-testid="storage-section">
            <h2 className="h-card">{t("settings.storage.title")}</h2>
            <p className="mb4" data-testid="storage-used">{t("settings.storage.used", { used: formatMegabytes(storage.used_bytes, i18n.language), quota: formatMegabytes(storage.quota_bytes, i18n.language) })}</p>
            <meter className="storage-meter" min={0} max={storage.quota_bytes} value={storage.used_bytes} aria-label={t("settings.storage.title")} />
            <p className="hint mb0">{t("settings.storage.hint")}</p>
          </section>
        ) : null}
        <section className="card" data-testid="install-section">
          <h2 className="h-card">{t("install.title")}</h2>
          {install === "installed" ? <p className="hint mb0">{t("install.installed")}</p> : null}
          {install === "prompt" ? <><p className="hint mb12">{t("install.why")}</p><Button variant="secondary" onClick={() => { void promptInstall().then((r) => { if (r === "dismissed") toast(t("install.dismissedHint")); }); }}>{t("install.button")}</Button></> : null}
          {install === "ios" ? <p className="hint mb0">{t("install.ios")}</p> : null}
          {install === "manual" ? <p className="hint mb0">{t("install.manual")}</p> : null}
        </section>
        <section className="card" data-testid="passkey-section">
          <h2 className="h-card">{t("settings.passkey.title")}</h2>
          <p className="hint mb12">{t(me?.passkeys.length ? "settings.passkey.listHint" : "settings.passkey.offHint")}</p>
          {me?.passkeys.length ? (
            <ul className="m0 mb12 p0" data-testid="passkey-list">
              {me.passkeys.map((p) => (
                <li key={p.id} className="passkey-row" data-testid="passkey-row">
                  <span>
                    <span className="switch-label">{p.label || t("settings.passkey.unnamed")}</span>
                    <span className="hint m0">{t("settings.passkey.addedOn", { date: new Date(p.created_at).toLocaleDateString(i18n.language) })}</span>
                  </span>
                  <Button variant="ghost" onClick={() => { setPkErr({}); setPkLp(""); setPkRemove(p); }} aria-label={t("settings.passkey.removeNamed", { name: p.label || t("settings.passkey.unnamed") })}>{t("settings.passkey.remove")}</Button>
                </li>
              ))}
            </ul>
          ) : null}
          {!pkAvail ? <p className="hint">{t("settings.passkey.unsupported")}</p>
            : <Button variant="secondary" onClick={() => { setPkErr({}); setPkAdd(true); }}>{t("settings.passkey.add")}</Button>}
        </section>
        {isClerk() ? null : <section className="card">
          <h2 className="h-card">{t("settings.joinLink")}</h2>
          <p className="hint mb10">{t("settings.joinLinkHint")}</p>
          {joinLink ? (
            <>
              <p className="code fs13" data-testid="join-link">{joinLink}</p>
              <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(joinLink).then(() => toast(t("settings.joinLinkCopied"))); }}>{t("settings.joinLinkCopy")}</Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => { void api<{ token: string }>("POST", "/join-links", {}).then((r) => setJoinLink(`${location.origin}/join#${r.token}`)); }}>{t("settings.joinLinkCreate")}</Button>
          )}
        </section>}
        <section className="card">
          <h2 className="h-card">{t("settings.account")}</h2>
          {me ? <p className="hint mb12">{t("settings.signedInAs", { email: me.email })}</p> : null}
          <p className="hint mb4">{t("settings.safetyNumber")}</p>
          <p className="safety" data-testid="safety-number">{safety}</p>
          <p className="hint">{t("settings.safetyNumberHint")}</p>
          <div className="actions">
            <Button variant="secondary" onClick={() => { void lockNow().then(() => { toast(t("auth.lock.locked")); nav("/unlock", { replace: true }); }); }}>{t("auth.lock.now")}</Button>
            <Button variant="secondary" onClick={() => { void signOut().then(() => nav("/", { replace: true })); }}>{t("auth.signOut")}</Button>
          </div>
          {me?.vault
            ? <p className="mt12 mb0"><Button variant="ghost" onClick={() => setCp(true)}>{t("settings.changePassphrase")}</Button></p>
            : <p className="mt12 mb0"><Button variant="ghost" onClick={() => { setCErr({}); setSp(true); }} data-testid="set-passphrase">{t("settings.setPassphrase")}</Button></p>}
          <p className="mt4 mb0"><Button variant="ghost" onClick={() => { closeRc(); setRc(true); }} data-testid="new-recovery-code">{t("settings.recovery.new")}</Button></p>
          <p className="mt4 mb0"><Button variant="ghost" onClick={() => nav("/privacy")}>{t("privacy.link")}</Button></p>
          {me?.is_admin ? <p className="mt4 mb0"><Button variant="ghost" onClick={() => nav("/admin")} data-testid="admin-link">{t("admin.link")}</Button></p> : null}
          <p className="mt4 mb0"><Button variant="ghost" onClick={() => nav("/settings/delete")}>{t("settings.deleteAccount")}</Button></p>
        </section>
        {appVersion() ? <p className="hint mt12 mb0" data-testid="app-version">Petty {appVersion()}</p> : null}
      </main>
      <Sheet open={pkAdd} title={t("settings.passkey.add")} onClose={() => setPkAdd(false)}>
        <form onSubmit={doPasskeyAdd} noValidate>
          <p className="hint mb12">{t(me?.vault ? "settings.passkey.addHint" : "settings.passkey.addHintPasskey")}</p>
          <TextField label={t("settings.passkey.label")} value={pkLabel} onChange={(e) => setPkLabel(e.target.value)} hint={t("settings.passkey.labelHint")} autoComplete="off" autoFocus />
          <input type="text" name="username" autoComplete="username" value={me ? vaultUsername(me.email) : ""} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
          {me?.vault ? <TextField label={t("auth.unlock.passphrase")} type="password" name="vault-passphrase" autoComplete="current-password" value={pkPass} onChange={(e) => setPkPass(e.target.value)} error={pkErr["pass"]} /> : null}
          {isClerk() ? null : <TextField label={t("auth.unlock.loginPassword")} type="password" autoComplete="current-password" value={pkLp} onChange={(e) => setPkLp(e.target.value)} error={pkErr["lp"]} />}
          {isClerk() && pkErr["lp"] ? <p className="error" role="alert">{pkErr["lp"]}</p> : null}
          <div className="actions">
            <Button variant="secondary" onClick={() => setPkAdd(false)}>{t("app.cancel")}</Button>
            <Button type="submit" busy={pkBusy}>{t("settings.passkey.add")}</Button>
          </div>
        </form>
      </Sheet>
      <Sheet open={!!pkRemove} title={t("settings.passkey.removeTitle")} onClose={() => setPkRemove(null)}>
        <form onSubmit={doPasskeyRemove} noValidate>
          <p className="hint mb12">{t("settings.passkey.removeHint", { name: pkRemove?.label || t("settings.passkey.unnamed") })}</p>
          {isClerk() ? <p className="hint">{t("settings.passkey.removeClerk")}</p> : <TextField label={t("auth.unlock.loginPassword")} type="password" autoComplete="current-password" value={pkLp} onChange={(e) => setPkLp(e.target.value)} error={pkErr["lp"]} autoFocus />}
          {isClerk() && pkErr["lp"] ? <p className="error" role="alert">{pkErr["lp"]}</p> : null}
          <div className="actions">
            <Button variant="secondary" onClick={() => setPkRemove(null)}>{t("app.cancel")}</Button>
            <Button type="submit" variant="danger" busy={pkBusy}>{t("settings.passkey.remove")}</Button>
          </div>
        </form>
      </Sheet>
      <Sheet open={rc} title={t("settings.recovery.new")} onClose={closeRc}>
        {!rcNew ? (
          <form onSubmit={doRecoveryOpen} noValidate data-testid="recovery-open-form">
            <p className="hint mb12">{t(me?.vault ? "settings.recovery.hint" : "settings.recovery.hintPasskey")}</p>
            <input type="text" name="username" autoComplete="username" value={me ? vaultUsername(me.email) : ""} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
            {me?.vault ? <TextField label={t("auth.unlock.passphrase")} type="password" name="vault-passphrase" autoComplete="current-password" value={rcPass} onChange={(e) => setRcPass(e.target.value)} error={rcErr["pass"]} autoFocus /> : null}
            {rcErr["lp"] ? <p className="error" role="alert">{rcErr["lp"]}</p> : null}
            <div className="actions">
              <Button variant="secondary" onClick={closeRc}>{t("app.cancel")}</Button>
              <Button type="submit" busy={rcBusy}>{t("settings.recovery.make")}</Button>
            </div>
          </form>
        ) : (
          <form onSubmit={doRecoveryStore} noValidate data-testid="recovery-confirm-form">
            <p className="hint mb8">{t("auth.recovery.body")}</p>
            <p className="code" data-testid="new-recovery-code-value">{rcNew.code}</p>
            <TextField label={t("auth.recovery.confirmLabel")} value={rcTyped} onChange={(e) => { setRcTyped(e.target.value); setRcErr({}); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} error={rcErr["typed"]} />
            {isClerk() ? null : <TextField label={t("auth.unlock.loginPassword")} type="password" autoComplete="current-password" value={rcLp} onChange={(e) => setRcLp(e.target.value)} error={rcErr["lp"]} />}
            <div className="actions">
              <Button variant="secondary" onClick={closeRc}>{t("app.cancel")}</Button>
              <Button type="submit" busy={rcBusy}>{t("auth.recovery.done")}</Button>
            </div>
          </form>
        )}
      </Sheet>
      <Sheet open={sp} title={t("settings.setPassphrase")} onClose={() => setSp(false)}>
        <form onSubmit={doSetPassphrase} noValidate data-testid="set-passphrase-form">
          <p className="hint mb12">{t("settings.setPassphraseHint")}</p>
          <input type="text" name="username" autoComplete="username" value={me ? vaultUsername(me.email) : ""} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
          <TextField label={t("auth.unlock.newPassphrase")} type="password" name="vault-passphrase" autoComplete="new-password" value={np} onChange={(e) => setNp(e.target.value)} hint={t("auth.join.passphraseHint")} error={cErr["np"]} autoFocus />
          <TextField label={t("auth.unlock.newPassphraseRepeat")} type="password" autoComplete="new-password" value={np2} onChange={(e) => setNp2(e.target.value)} error={cErr["np2"]} />
          {isClerk() ? null : <TextField label={t("auth.unlock.loginPassword")} type="password" autoComplete="current-password" value={lp} onChange={(e) => setLp(e.target.value)} error={cErr["lp"]} />}
          <div className="actions">
            <Button variant="secondary" onClick={() => setSp(false)}>{t("app.cancel")}</Button>
            <Button type="submit" busy={cBusy}>{t("app.save")}</Button>
          </div>
        </form>
      </Sheet>
      <Sheet open={cp} title={t("settings.changePassphrase")} onClose={() => setCp(false)}>
        <form onSubmit={doChange} noValidate>
          <input type="text" name="username" autoComplete="username" value={me ? vaultUsername(me.email) : ""} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
          <TextField label={t("settings.currentPassphrase")} type="password" name="vault-passphrase-current" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} error={cErr["cur"]} autoFocus />
          <TextField label={t("auth.unlock.newPassphrase")} type="password" name="vault-passphrase" autoComplete="new-password" value={np} onChange={(e) => setNp(e.target.value)} hint={t("auth.join.passphraseHint")} error={cErr["np"]} />
          <TextField label={t("auth.unlock.newPassphraseRepeat")} type="password" autoComplete="new-password" value={np2} onChange={(e) => setNp2(e.target.value)} error={cErr["np2"]} />
          {isClerk() ? null : <TextField label={t("auth.unlock.loginPassword")} type="password" autoComplete="current-password" value={lp} onChange={(e) => setLp(e.target.value)} error={cErr["lp"]} />}
          <div className="actions">
            <Button variant="secondary" onClick={() => setCp(false)}>{t("app.cancel")}</Button>
            <Button type="submit" busy={cBusy}>{t("app.save")}</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
