import { useTranslation } from "react-i18next";
import { memberName, type DrawerView } from "../lib/drawers.js";

/** A reader sees the same screens minus every write control; this one line says why (PETTY-115, audit F8). */
export function ReadOnlyHint({ view }: { view: DrawerView }) {
  const { t } = useTranslation();
  if (view.summary.role !== "read") return null;
  return <p className="hint readonly-hint" role="status" data-testid="readonly-hint">{t("drawer.readOnly", { owner: memberName(view, view.summary.owner_id) })}</p>;
}
