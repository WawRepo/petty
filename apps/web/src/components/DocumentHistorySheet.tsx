import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";
import { useToast } from "./Toast.js";
import { documentHistory, openKeptPhoto, photoHistory, restoreDocument, restorePhoto, type DocumentVersion, type PhotoVersion } from "../lib/drawers.js";
import { photoUrl } from "../lib/photo.js";
import { dateLocale } from "../lib/time.js";

/**
 * Earlier versions of a drawer (PETTY-194): the owner can put one back after a bad change, for
 * example a tool that wrote a broken document (PETTY-183). Opened in the browser; the server only
 * holds ciphertext. PETTY-506: earlier photos too, replaced or removed in the last 30 days.
 */
export function DocumentHistorySheet({ open, drawerId, onClose }: { open: boolean; drawerId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [list, setList] = useState<DocumentVersion[] | null>(null);
  const [photos, setPhotos] = useState<PhotoVersion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(i18n.language));

  useEffect(() => {
    if (!open) return;
    setList(null); setPhotos(null); setFailed(false);
    documentHistory(drawerId).then(setList, () => setFailed(true));
    photoHistory(drawerId).then(setPhotos, () => setPhotos([]));
  }, [open, drawerId]);

  async function restore(v: DocumentVersion) {
    setBusy(v.id);
    try {
      await restoreDocument(drawerId, v.id);
      toast(t("drawer.history.restored"));
      onClose();
    } catch {
      toast(t("errors.unknown"));
    } finally { setBusy(null); }
  }

  return (
    <Sheet open={open} title={t("drawer.history.title")} onClose={onClose}>
      <p className="hint mb12">{t("drawer.history.hint")}</p>
      {failed ? <p className="error" role="alert">{t("errors.unknown")}</p> : null}
      {!failed && list === null ? <p className="empty">{t("app.loading")}</p> : null}
      {list && list.length === 0 ? <p className="empty" data-testid="history-empty">{t("drawer.history.empty")}</p> : null}
      {list && list.length ? (
        <ul className="m0 p0" data-testid="history-list">
          {list.map((v) => (
            <li key={v.id} className="passkey-row" data-testid="history-row">
              <span>
                <span className="switch-label">{v.name ?? t("drawer.history.unreadable")}</span>
                <span className="hint m0">
                  {when(v.replacedAt)}
                  {v.lines !== null ? ` · ${t("drawer.history.lines", { count: v.lines })}` : ""}
                  {v.byToken ? ` · ${t("drawer.history.byTool")}` : ""}
                </span>
              </span>
              {v.name !== null ? <Button variant="ghost" busy={busy === v.id} onClick={() => { void restore(v); }} aria-label={t("drawer.history.restoreNamed", { when: when(v.replacedAt) })}>{t("drawer.history.restore")}</Button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {photos && photos.length ? (
        <>
          <h3 className="h-card mt12" id="history-photos">{t("drawer.history.photosTitle")}</h3>
          <ul className="m0 p0" data-testid="photo-history-list" aria-labelledby="history-photos">
            {photos.map((p) => <KeptPhotoRow key={p.id} drawerId={drawerId} version={p} when={when(p.replacedAt)} onRestored={onClose} />)}
          </ul>
        </>
      ) : null}
    </Sheet>
  );
}

/** One kept photo: shown on demand (up to 300 KiB each), then put back. */
function KeptPhotoRow({ drawerId, version, when, onRestored }: { drawerId: string; version: PhotoVersion; when: string; onRestored: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [shown, setShown] = useState<string | null | "unreadable">(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (shown && shown !== "unreadable") URL.revokeObjectURL(shown); }, [shown]);

  async function show() {
    setBusy(true);
    try {
      const bytes = await openKeptPhoto(drawerId, version.id);
      setShown(bytes ? photoUrl(bytes) : "unreadable");
    } catch { toast(t("errors.unknown")); } finally { setBusy(false); }
  }
  async function restore() {
    setBusy(true);
    try {
      await restorePhoto(drawerId, version.id);
      toast(t("drawer.history.photoRestored"));
      onRestored();
    } catch { toast(t("errors.unknown")); } finally { setBusy(false); }
  }

  return (
    <li className="passkey-row" data-testid="photo-history-row">
      <span>
        <span className="switch-label">{t(version.removed ? "drawer.history.photoRemoved" : "drawer.history.photoReplaced")}</span>
        <span className="hint m0">{when}</span>
        {shown === "unreadable" ? <span className="hint m0">{t("drawer.history.unreadable")}</span> : null}
        {shown && shown !== "unreadable" ? <img src={shown} alt={t("drawer.history.photoAlt", { when })} className="kept-photo" data-testid="kept-photo" /> : null}
      </span>
      {shown === null
        ? <Button variant="ghost" busy={busy} onClick={() => { void show(); }} aria-label={t("drawer.history.photoShowNamed", { when })}>{t("drawer.history.photoShow")}</Button>
        : shown !== "unreadable"
          ? <Button variant="ghost" busy={busy} onClick={() => { void restore(); }} aria-label={t("drawer.history.photoRestoreNamed", { when })}>{t("drawer.history.restore")}</Button>
          : null}
    </li>
  );
}
