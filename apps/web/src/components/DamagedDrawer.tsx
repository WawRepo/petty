import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { Button } from "./Button.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { DocumentHistorySheet } from "./DocumentHistorySheet.js";
import { DrawerBoundary } from "./DrawerBoundary.js";
import { TopBar } from "./TopBar.js";
import { deleteDrawer, leaveDrawer, useDrawers } from "../lib/drawers.js";
import { useBack } from "../lib/nav.js";

/**
 * A drawer that cannot be shown (PETTY-443): the reason, and the ways out that this person's role allows.
 * The owner can put back an earlier version (the server keeps them 30 days) or delete the drawer; anyone
 * else can leave it. A drawer's own screens show this when the drawer did not open or failed to draw, so
 * a damaged drawer is never a dead end.
 */
export function DamagedDrawer({ id }: { id: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const back = useBack("/");
  const view = useDrawers().drawers.get(id);
  const [sheet, setSheet] = useState<null | "history" | "leave" | "delete">(null);
  const reason = view?.error ?? "bad_document";
  const name = view?.doc?.name ?? view?.name ?? null;
  const isOwner = view?.summary.role === "owner";
  // an earlier version is opened with the drawer key; a document from a newer Petty is not damage to undo
  const canRestore = isOwner && !!view?.key && reason !== "unknown_schema";
  return (
    <>
      <TopBar title={name ?? t("app.name")} onBack={back} />
      <main data-testid="drawer-damaged">
        <p className="error" role="alert">{t(`home.degradedReason.${reason}`)}</p>
        {view ? (
          <div className="actions">
            {/* who is in the drawer: where a safety number is compared, and where the owner removes a member */}
            <Button variant="secondary" onClick={() => nav(`/drawers/${id}/members`)}>{t("members.open")}</Button>
            {canRestore ? <Button variant="secondary" onClick={() => setSheet("history")} data-testid="drawer-history">{t("drawer.history.title")}</Button> : null}
            {/* the one that takes something away comes last (PETTY-279) */}
            {isOwner ? <Button variant="danger-ghost" onClick={() => setSheet("delete")} data-testid="damaged-delete">{t("drawer.delete")}</Button>
              : <Button variant="danger-ghost" onClick={() => setSheet("leave")} data-testid="damaged-leave">{t("members.leave")}</Button>}
          </div>
        ) : null}
      </main>
      {canRestore ? <DocumentHistorySheet open={sheet === "history"} drawerId={id} onClose={() => setSheet(null)} /> : null}
      <ConfirmSheet open={sheet === "leave"} title={t("members.leave")} body={t("members.leaveConfirm")} confirmLabel={t("members.leave")} onClose={() => setSheet(null)}
        onConfirm={async () => { await leaveDrawer(id); nav("/", { replace: true }); }} />
      {/* PETTY-62: a delete is typed, not tapped. A drawer whose name cannot be read is confirmed with the button's own word. */}
      <ConfirmSheet open={sheet === "delete"} title={t("drawer.delete")} body={name ? t("drawer.deleteConfirm", { name }) : t("drawer.deleteDamagedConfirm")} confirmLabel={t("drawer.deleteBtn")} onClose={() => setSheet(null)}
        challenge={name ? { label: t("drawer.deleteType"), expected: name, testId: "delete-drawer-name" } : { label: t("drawer.deleteDamagedType"), expected: t("drawer.deleteBtn"), testId: "delete-drawer-name" }}
        onConfirm={async () => { await deleteDrawer(id); nav("/", { replace: true }); }} />
    </>
  );
}

/**
 * The fence round a drawer's own screens (the drawer, one of its items): a screen that fails to draw becomes
 * the damaged-drawer view. One fence per address, so a failure of one screen is not carried to the next.
 */
export function DrawerFence({ children }: { children: ReactNode }) {
  const { id = "", lineId = "" } = useParams();
  const view = useDrawers().drawers.get(id);
  return <DrawerBoundary key={`${id}/${lineId}`} resetKey={view} fallback={<DamagedDrawer id={id} />}>{children}</DrawerBoundary>;
}
