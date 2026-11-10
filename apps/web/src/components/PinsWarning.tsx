import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.js";
import { loadAll } from "../lib/drawers.js";
import { acknowledgeRollback, usePins } from "../lib/pins.js";

/** Shown when the server lost or rolled back the user's trusted-keys document (security review SR-3). */
export function PinsWarning() {
  const { t } = useTranslation();
  const pins = usePins();
  // PETTY-438: what the warning said when "start over" was chosen. It stays on screen, busy, until the new list is
  // saved and the drawers are loaded again; a page left before that shows the warning once more.
  const [busy, setBusy] = useState<null | { missing: boolean; seen: number; server: number }>(null);
  if (pins.status !== "rolled_back" && !busy) return null;
  // no list on the server and none seen here (a browser new to the account) is said in its own words
  const shown = busy ?? { missing: pins.lastSeenVersion === 0 && pins.version === 0, seen: pins.lastSeenVersion, server: pins.version };
  return (
    <div className="warn-box" role="alert" data-testid="pins-rolled-back">
      <p className="m0 fw700">{t(shown.missing ? "pins.missingTitle" : "pins.rolledBackTitle")}</p>
      <p className="hint my6">{shown.missing ? t("pins.missing") : t("pins.rolledBack", { seen: shown.seen, server: shown.server })}</p>
      <Button variant="secondary" busy={busy !== null} onClick={() => { setBusy(shown); void acknowledgeRollback().then(() => loadAll()).catch(() => undefined).finally(() => setBusy(null)); }}>{t("pins.startOver")}</Button>
    </div>
  );
}
