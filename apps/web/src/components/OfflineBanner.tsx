import { useTranslation } from "react-i18next";
import { useDrawers } from "../lib/drawers.js";
import { useOnline } from "../lib/net.js";
import { OUTBOX_OLD_MS } from "../lib/outbox.js";

/** Connectivity and outbox state, as one quiet line. */
export function OfflineBanner() {
  const { t } = useTranslation();
  const online = useOnline();
  const s = useDrawers();
  if (online && s.outboxCount === 0 && !s.fromCache) return null;
  return (
    <div className="warn-box" role="status" data-testid="offline-banner">
      {!online ? <div>{t("offline.banner")}</div> : null}
      {s.fromCache ? <div>{t("offline.cached")}</div> : null}
      {s.outboxCount > 0 ? <div data-testid="pending-count">{t("offline.pending", { count: s.outboxCount })}</div> : null}
      {s.outboxOldest !== null && s.outboxOldest > OUTBOX_OLD_MS ? <div className="error mt4 mb0" data-testid="outbox-old">{t("offline.old")}</div> : null}
    </div>
  );
}
