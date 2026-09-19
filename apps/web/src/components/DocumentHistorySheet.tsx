import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";
import { useToast } from "./Toast.js";
import { documentHistory, restoreDocument, type DocumentVersion } from "../lib/drawers.js";

/**
 * Earlier versions of a drawer (PETTY-194): the owner can put one back after a bad change, for
 * example a tool that wrote a broken document (PETTY-183). Opened in the browser; the server only
 * holds ciphertext.
 */
export function DocumentHistorySheet({ open, drawerId, onClose }: { open: boolean; drawerId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [list, setList] = useState<DocumentVersion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setList(null); setFailed(false);
    documentHistory(drawerId).then(setList, () => setFailed(true));
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
                  {new Date(v.replacedAt).toLocaleString(i18n.language)}
                  {v.lines !== null ? ` · ${t("drawer.history.lines", { count: v.lines })}` : ""}
                  {v.byToken ? ` · ${t("drawer.history.byTool")}` : ""}
                </span>
              </span>
              {v.name !== null ? <Button variant="ghost" busy={busy === v.id} onClick={() => { void restore(v); }} aria-label={t("drawer.history.restoreNamed", { when: new Date(v.replacedAt).toLocaleString(i18n.language) })}>{t("drawer.history.restore")}</Button> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Sheet>
  );
}
