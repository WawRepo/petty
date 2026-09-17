import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.js";
import { acknowledgeRollback, usePins } from "../lib/pins.js";

/** Shown when the server lost or rolled back the user's trusted-keys document (security review SR-3). */
export function PinsWarning() {
  const { t } = useTranslation();
  const pins = usePins();
  const [busy, setBusy] = useState(false);
  if (pins.status !== "rolled_back") return null;
  return (
    <div className="warn-box" role="alert" data-testid="pins-rolled-back">
      <p className="m0 fw700">{t("pins.rolledBackTitle")}</p>
      <p className="hint my6">{t("pins.rolledBack", { seen: pins.lastSeenVersion, server: pins.version })}</p>
      <Button variant="secondary" busy={busy} onClick={() => { setBusy(true); void acknowledgeRollback().finally(() => setBusy(false)); }}>{t("pins.startOver")}</Button>
    </div>
  );
}
