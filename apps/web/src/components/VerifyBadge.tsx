import { useTranslation } from "react-i18next";
import { staleness } from "@petty/ledger";
import type { DrawerView } from "../lib/drawers.js";
import { relativeTime } from "../lib/time.js";

/** "Not yet verified" / "Verified · 3 days ago" / "Needs verification · Changed 3 days ago" — from the server-stamped timestamps (SPEC-ISSUES B3). */
export function VerifyBadge({ view }: { view: DrawerView }) {
  const { t, i18n } = useTranslation();
  if (!view.doc) return null;
  const s = staleness(view.doc, view.summary);
  if (s.status === "never") return <span className="verify-badge never" data-testid="verify-badge" data-status="never"><span className="dot" aria-hidden="true" />{t("verify.notYet")}</span>;
  const when = relativeTime(view.summary.last_verified_at!, i18n.language, t);
  if (s.status === "stale") return <span className="verify-badge stale" data-testid="verify-badge" data-status="stale"><span className="dot" aria-hidden="true" />{t("verify.changed", { when })}</span>;
  return <span className="verify-badge ok" data-testid="verify-badge" data-status="verified"><span className="dot" aria-hidden="true" />{t("verify.verified", { when })}</span>;
}
