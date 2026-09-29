import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { WrongPassphrase, EXPORT_PASSWORD_MIN_LENGTH } from "@petty/crypto";
import { Button } from "./Button.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { Sheet } from "./Sheet.js";
import { TextField } from "./TextField.js";
import { useToast } from "./Toast.js";
import { buildExport, downloadText, exportEncrypted, exportPlain, importPayload, openImport, parseImportFile, type ImportProgress, type ParsedImport } from "../lib/archive.js";

export function BackupSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const [sheet, setSheet] = useState<null | "password" | "plain" | "importPassword">(null);
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  // PETTY-279: a password too short is marked on the password field, a mismatch on the repeat field
  const [pwError, setPwError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function doEncrypted(e: FormEvent) {
    e.preventDefault();
    setPwError(null); setError(null);
    if (pw.normalize("NFKC").length < EXPORT_PASSWORD_MIN_LENGTH) { setPwError(t("backup.passwordShort")); return; }
    if (pw !== pw2) { setError(t("backup.passwordMismatch")); return; }
    setBusy(true);
    try {
      const { skipped } = await buildExport();
      const f = await exportEncrypted(pw);
      downloadText(f.name, f.text);
      toast(t("backup.exported"));
      if (skipped) toast(t("backup.skipped", { count: skipped }));
      setSheet(null); setPw(""); setPw2("");
    } catch { setError(t("errors.unknown")); } finally { setBusy(false); }
  }
  async function doPlain() {
    const f = await exportPlain();
    downloadText(f.name, f.text);
    toast(t("backup.exported"));
  }
  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      const p = parseImportFile(await file.text());
      if (p.kind === "encrypted") { setParsed(p); setPw(""); setError(null); setSheet("importPassword"); }
      else await runImport(await openImport(p, ""));
    } catch { toast(t("backup.importInvalid")); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  }
  async function doImportPassword(e: FormEvent) {
    e.preventDefault();
    if (!parsed) return;
    setBusy(true); setError(null);
    try {
      const payload = await openImport(parsed, pw);
      setSheet(null);
      await runImport(payload);
    } catch (err) { setError(err instanceof WrongPassphrase ? t("backup.importWrongPassword") : t("backup.importInvalid")); }
    finally { setBusy(false); }
  }
  async function runImport(payload: Awaited<ReturnType<typeof openImport>>) {
    setProgress({ drawer: "", done: 0, total: 0 });
    try {
      const ids = await importPayload(payload, setProgress);
      toast(t("backup.imported", { count: ids.length }));
      nav("/");
    } finally { setProgress(null); }
  }

  return (
    <section className="card">
      <h2 className="h-card">{t("backup.title")}</h2>
      <p className="hint mb12">{t("backup.hint")}</p>
      {progress ? <p className="warn-box" role="status" data-testid="import-progress">{t("backup.importing", progress)}</p> : null}
      <div className="actions mt0">
        <Button variant="secondary" onClick={() => { setPw(""); setPw2(""); setError(null); setPwError(null); setSheet("password"); }}>{t("backup.exportEncrypted")}</Button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" id="import-input" aria-label={t("backup.importFile")} onChange={(e) => void onFile(e.target.files?.[0])} />
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={progress !== null}>{t("backup.import")}</Button>
      </div>
      {/* PETTY-137 (audit F30): the unencrypted export sits apart, under a divider with its one-line warning; the confirm sheet stays. */}
      <div className="plain-export" data-testid="plain-export">
        <p className="hint m0 fs13">{t("backup.plainLead")}</p>
        <Button variant="danger-ghost" onClick={() => setSheet("plain")}>{t("backup.exportPlain")}</Button>
      </div>
      <Sheet open={sheet === "password"} title={t("backup.exportEncrypted")} onClose={() => setSheet(null)}>
        <form onSubmit={doEncrypted} noValidate>
          <TextField label={t("backup.password")} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint={t("backup.passwordHint")} error={pwError} autoFocus />
          <TextField label={t("backup.passwordRepeat")} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} error={error} />
          <div className="actions">
            <Button variant="secondary" onClick={() => setSheet(null)}>{t("app.cancel")}</Button>
            <Button type="submit" busy={busy}>{busy ? t("backup.exporting") : t("backup.download")}</Button>
          </div>
        </form>
      </Sheet>
      <ConfirmSheet open={sheet === "plain"} title={t("backup.plainTitle")} body={t("backup.plainWarning")} confirmLabel={t("backup.plainConfirm")} onClose={() => setSheet(null)} onConfirm={doPlain} />
      <Sheet open={sheet === "importPassword"} title={t("backup.importTitle")} onClose={() => setSheet(null)}>
        <p className="hint">{t("backup.importHint")}</p>
        <form onSubmit={doImportPassword} noValidate>
          <TextField label={t("backup.importPassword")} type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} error={error} autoFocus />
          <div className="actions">
            <Button variant="secondary" onClick={() => setSheet(null)}>{t("app.cancel")}</Button>
            <Button type="submit" busy={busy}>{t("backup.importTitle")}</Button>
          </div>
        </form>
      </Sheet>
    </section>
  );
}
