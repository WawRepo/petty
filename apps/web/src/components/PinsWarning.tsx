import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { useToast } from "./Toast.js";
import { loadAll } from "../lib/drawers.js";
import { acknowledgeRollback, keptUserDocs, putBackUserDoc, usePins, type KeptUserDoc } from "../lib/pins.js";
import { dateLocale } from "../lib/time.js";

/** Shown when the server lost or rolled back the user's trusted-keys document (security review SR-3). */
export function PinsWarning() {
  const { t } = useTranslation();
  const pins = usePins();
  // PETTY-438: what the warning said when "start over" was chosen. It stays on screen, busy, until the new list is
  // saved and the drawers are loaded again; a page left before that shows the warning once more.
  const [busy, setBusy] = useState<null | { missing: boolean; inside: boolean; seen: number; server: number }>(null);
  if (pins.status === "unreadable") return <UnreadableWarning />;
  if (pins.status !== "rolled_back" && !busy) return null;
  // no list on the server and none seen here (a browser new to the account) is said in its own words
  // PETTY-439: an older copy that the server numbers as not older is told by the counter inside it; the two numbers would say the opposite
  const shown = busy ?? { missing: pins.lastSeenVersion === 0 && pins.version === 0, inside: pins.olderInside === true, seen: pins.lastSeenVersion, server: pins.version };
  return (
    <div className="warn-box" role="alert" data-testid="pins-rolled-back">
      <p className="m0 fw700">{t(shown.missing ? "pins.missingTitle" : "pins.rolledBackTitle")}</p>
      <p className="hint my6">{shown.missing ? t("pins.missing") : shown.inside ? t("pins.rolledBackInside") : t("pins.rolledBack", { seen: shown.seen, server: shown.server })}</p>
      <Button variant="secondary" busy={busy !== null} onClick={() => { setBusy(shown); void acknowledgeRollback().then(() => loadAll()).catch(() => undefined).finally(() => setBusy(null)); }}>{t("pins.startOver")}</Button>
    </div>
  );
}

/**
 * PETTY-506: the server's copy of the list does not open here. The server keeps replaced copies 30 days; this offers
 * the newest one that opens and is not older than what this browser saw, or a new, empty list. Each after a confirm.
 */
function UnreadableWarning() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [copy, setCopy] = useState<KeptUserDoc | null | undefined>(undefined); // undefined: still looking
  const [ask, setAsk] = useState<null | "copy" | "new">(null);
  useEffect(() => { keptUserDocs().then((c) => setCopy(c[0] ?? null), () => setCopy(null)); }, []);
  const when = copy ? new Date(copy.replacedAt).toLocaleString(dateLocale(i18n.language)) : "";
  const putBack = async (id: string | null) => {
    try {
      await putBackUserDoc(id);
      toast(t(id ? "pins.putBackDone" : "pins.startedNew"));
      await loadAll().catch(() => undefined);
    } catch { toast(t("errors.unknown")); }
  };
  return (
    <div className="warn-box" role="alert" data-testid="pins-unreadable">
      <p className="m0 fw700">{t("pins.unreadableTitle")}</p>
      <p className="hint my6">{t("pins.unreadable")}</p>
      {copy === undefined ? <p className="hint my6">{t("app.loading")}</p> : <p className="hint my6">{copy ? t("pins.unreadableCopy", { when }) : t("pins.unreadableNoCopy")}</p>}
      <div className="actions">
        {copy ? <Button variant="primary" onClick={() => setAsk("copy")} data-testid="pins-put-back">{t("pins.putBack", { when })}</Button> : null}
        <Button variant="secondary" disabled={copy === undefined} onClick={() => setAsk("new")}>{t("pins.startOver")}</Button>
      </div>
      <ConfirmSheet open={ask === "copy"} danger={false} title={t("pins.putBackTitle")} body={t("pins.putBackBody", { when })} confirmLabel={t("pins.putBackConfirm")} onClose={() => setAsk(null)} onConfirm={() => putBack(copy?.id ?? null)} />
      <ConfirmSheet open={ask === "new"} title={t("pins.startNewTitle")} body={t("pins.startNewBody")} confirmLabel={t("pins.startOver")} onClose={() => setAsk(null)} onConfirm={() => putBack(null)} />
    </div>
  );
}
