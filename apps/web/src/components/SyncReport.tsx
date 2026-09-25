import { useTranslation } from "react-i18next";
import { formatMoney, formatCount } from "@petty/ledger";
import { Button } from "./Button.js";
import { memberName, useDrawers } from "../lib/drawers.js";
import { dismissReport, useSyncReport, type ReportItem } from "../lib/sync.js";

/** "While you were away": what changed on the server while this device was offline, and which queued changes were refused. */
export function SyncReport() {
  const { t, i18n } = useTranslation();
  const report = useSyncReport();
  const s = useDrawers();
  if (!report) return null;
  const line = (it: { drawer_id: string; line_id: string }) => {
    const v = s.drawers.get(it.drawer_id);
    const l = v?.doc?.lines.find((x) => x.id === it.line_id);
    return { v, l, name: l?.name ?? "?" };
  };
  const text = (it: ReportItem): string => {
    switch (it.kind) {
      case "foreign": {
        const { v, l, name } = line(it);
        const amount = l?.kind === "money" ? `${it.amount >= 0 ? "+" : "−"}${formatMoney(Math.abs(it.amount), l.exponent, l.currency, i18n.language)}` : `${it.amount >= 0 ? "+" : "−"}${formatCount(Math.abs(it.amount), i18n.language)}`;
        return t("offline.report.foreign", { amount: it.op === "adjust" ? `${t("line.ops.adjust")} → ${amount.slice(1)}` : amount, name: v ? memberName(v, it.author_id) : "?", line: name });
      }
      case "recount": return t("offline.report.recount", { line: line(it).name });
      case "reverse_refused": return t("offline.report.reverseRefused", { line: line(it).name, reason: t(`line.reverse.refused.${it.reason}`) });
      case "ops_dropped": return t("offline.report.opsDropped", { drawer: s.drawers.get(it.drawer_id)?.doc?.name ?? "?" });
      case "storage_full": return t(it.mine ? "offline.report.storageFull" : "offline.report.ownerStorageFull", { drawer: s.drawers.get(it.drawer_id)?.doc?.name ?? "?" });
      case "failed": return t("offline.report.failed", { drawer: s.drawers.get(it.drawer_id)?.doc?.name ?? "?" });
    }
  };
  return (
    <section className="card mb12" role="alert" data-testid="sync-report">
      <h2 className="h-card">{t("offline.report.title")}</h2>
      <ul className="mb10 list">
        {report.items.map((it, i) => <li key={i}>{text(it)}</li>)}
      </ul>
      <Button variant="secondary" onClick={dismissReport}>{t("offline.report.dismiss")}</Button>
    </section>
  );
}
