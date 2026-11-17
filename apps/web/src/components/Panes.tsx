import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { matchPath, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../lib/session.js";
import { PaneContext, useWide, type Pane } from "../lib/panes.js";
import { PageSkeleton } from "./Skeleton.js";

/** A drawer's row in Home's list (`data-drawer-id`, HomeScreen), or the list itself when the row is not shown. */
function rowOf(list: HTMLElement | null, id: string): HTMLElement | null {
  return list?.querySelector<HTMLElement>(`button.row[data-drawer-id="${CSS.escape(id)}"]`) ?? list;
}

/**
 * Two panes from 900 px (PETTY-138). The routes stay as they are: on "/", "/drawers/:id" and
 * "/drawers/:id/lines/:lineId" Home's list stays on the left (`list`), and the drawer or item of the
 * address opens on the right; on "/" the right holds Home's total and picture. Narrower, signed out or
 * locked, it is the one-column app, unchanged.
 *
 * Focus: a row opened (any way into a drawer or item, back and forward included) moves focus to the right
 * pane's heading; the first address the panes show (a deep link, or back from Settings) keeps the browser's
 * own start. Escape in the right pane puts focus back on the drawer's row; its "Back to the list" button
 * closes the drawer, and focus goes to the row too.
 */
export function Panes({ list }: { list: ReactNode }) {
  const { t } = useTranslation();
  const wide = useWide();
  const auth = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const on = wide && auth.status === "unlocked";
  const lineMatch = matchPath("/drawers/:id/lines/:lineId", loc.pathname);
  const drawer = (lineMatch ?? matchPath("/drawers/:id", loc.pathname))?.params.id ?? null;
  const line = lineMatch?.params.lineId ?? null;
  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [overview, setOverview] = useState<HTMLElement | null>(null);
  const toList = useCallback(() => nav("/"), [nav]);
  const seen = useRef<{ key: string; drawer: string | null } | null>(null); // the address before this one

  useEffect(() => {
    const was = seen.current;
    seen.current = { key: loc.key, drawer };
    // the first address these panes show (a deep link, or back from Settings), or only the width changed: focus stays
    if (!on || !was || was.key === loc.key) return;
    if (!drawer) { if (was.drawer) rowOf(listRef.current, was.drawer)?.focus(); return; }
    const root = detailRef.current;
    if (!root) return;
    // the screens load lazily and draw a skeleton first (its title is no heading): wait for the h1
    const focus = () => {
      const h = root.querySelector<HTMLElement>(".topbar h1");
      if (!h) return false;
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
      return true;
    };
    if (focus()) return;
    const watch = new MutationObserver(() => { if (focus()) watch.disconnect(); });
    watch.observe(root, { childList: true, subtree: true });
    const stop = window.setTimeout(() => watch.disconnect(), 5000);
    return () => { watch.disconnect(); window.clearTimeout(stop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the address's key: each new entry, also to the same drawer
  }, [on, loc.key]);

  const listPane = useMemo<Pane>(() => ({ side: "list", drawer, line, overview, toList }), [drawer, line, overview, toList]);
  const detailPane = useMemo<Pane>(() => ({ ...listPane, side: "detail" }), [listPane]);
  if (!on) return <Outlet />;

  // A dialog's Escape is its own (useFocusTrap), and a field keeps its keys.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || !drawer) return;
    if (document.querySelector('[aria-modal="true"]') || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    rowOf(listRef.current, drawer)?.focus();
  };
  return (
    <div className="panes" data-testid="panes">
      <PaneContext.Provider value={listPane}>
        <nav className="pane-list" aria-label={t("home.drawersTitle")} ref={listRef} tabIndex={-1}>{list}</nav>
      </PaneContext.Provider>
      <PaneContext.Provider value={detailPane}>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape from anywhere in the pane; not a control of its own */}
        <div className="pane-detail" ref={detailRef} onKeyDown={onKeyDown}>
          {drawer ? (
            // one per drawer: another drawer's screen starts afresh (its filters, its open sheet), as from Home
            <Suspense key={drawer} fallback={<PageSkeleton />}><Outlet /></Suspense>
          ) : (
            <main className="pane-overview" data-testid="pane-overview">
              <div ref={setOverview} className="stack" />
              <p className="hint pane-hint">{t("home.pane.hint")}</p>
            </main>
          )}
        </div>
      </PaneContext.Provider>
    </div>
  );
}
