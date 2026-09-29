import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight, GripVertical, Minus, Plus } from "lucide-react";
import { useBack } from "../lib/nav.js";
import { Button } from "../components/Button.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { PlacePicker } from "../components/PlacePicker.js";
import { PromptSheet } from "../components/PromptSheet.js";
import { Sheet } from "../components/Sheet.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { useDrawers } from "../lib/drawers.js";
import { addPlace, drawersUnder, findNode as findNodeIn, flatten, movePlace, movePlaceTo, pathKey as pathKeyOf, PlaceExists, placeLabelOf, removePlace, renamePlace, rewriteDrawerPlaces, samePath, savePlaceTree, shiftPlace, usePlaceTree, type FlatPlace, type PlacePath } from "../lib/places.js";

type SheetState = null | { kind: "menu" | "rename" | "move" | "delete" | "add"; path: PlacePath };

/**
 * The place tree editor (PETTY-66). Every edit is a pure function on the tree, saved to the user
 * document; a rename, move or delete then rewrites the path on each drawer under the node.
 */
export function PlacesScreen() {
  const { t } = useTranslation();
  const back = useBack("/settings");
  const toast = useToast();
  const drawers = useDrawers();
  const tree = usePlaceTree();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [moved, setMoved] = useState(""); // live-region text for keyboard reorders (PETTY-130)
  const [sheet, setSheet] = useState<SheetState>(null);
  const [moveTo, setMoveTo] = useState<PlacePath | null>(null);
  const rows = flatten(tree, collapsed);
  const views = [...drawers.drawers.values()];
  const count = (path: PlacePath) => drawersUnder(views, path).length;
  const toggle = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const fail = (e: unknown) => toast(e instanceof PlaceExists ? t("places.exists") : t("errors.unknown"));
  const report = (r: { done: number; failed: number; readOnly: number }) => {
    if (r.failed) toast(t("places.rewriteFailed", { count: r.failed }));
    else if (r.readOnly) toast(t("places.rewriteReadOnly", { count: r.readOnly }));
    else if (r.done) toast(t("places.moved", { count: r.done }));
  };

  /**
   * Drag-and-drop, the drawer's way (PETTY-68): the held row follows the finger and the other rows slide
   * aside with a spring; the horizontal drag picks the level — right means inside the row above, left
   * means out a level. A branch is folded while it is held, so it travels as one row and can never be
   * dropped inside itself. The order and the level of the slot together give the new parent and index.
   */
  const INDENT = 20;
  const treeRef = useRef<HTMLDivElement>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const dragging = useRef<{ key: string; pointerId: number; startX: number; startY: number; from: number; target: number; depth: number; slide: number; gap: number; blocks: HTMLElement[]; mids: number[]; heights: number[]; rows: FlatPlace[]; wasOpen: boolean } | null>(null);
  const pendingDrop = useRef<{ keys: string; blocks: HTMLElement[] } | null>(null);
  useLayoutEffect(() => {
    const p = pendingDrop.current;
    if (!p) return;
    if (rows.map((r) => r.key).join() === p.keys) {
      for (const b of p.blocks) { b.style.transition = ""; b.style.transform = ""; }
      pendingDrop.current = null;
      setDragKey(null);
    }
  });
  /** The slot between `others[target-1]` and `others[target]`, at `depth`: the parent path and the index among its children. */
  function slotAt(others: FlatPlace[], target: number, wantDepth: number, held: FlatPlace): { parent: PlacePath; index: number; depth: number } {
    const prev = others[target - 1]; const next = others[target];
    const maxDepth = prev ? prev.depth + 1 : 0;
    const minDepth = next ? next.depth : 0;
    const depth = Math.max(minDepth, Math.min(maxDepth, wantDepth));
    const parent: PlacePath = prev ? prev.path.slice(0, depth) : [];
    const siblings = (parent.length ? (findNodeIn(tree, parent)?.children ?? []) : tree).filter((c) => !samePath([...parent, c.name], held.path));
    const before = prev && prev.depth >= depth ? prev.path.slice(0, depth + 1) : null;
    const index = before ? siblings.findIndex((c) => samePath([...parent, c.name], before)) + 1 : 0;
    return { parent, index, depth };
  }
  function onHandleDown(e: React.PointerEvent<HTMLButtonElement>, row: FlatPlace) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const wasOpen = !collapsed.has(row.key) && row.node.children.length > 0;
    // Fold the branch first so it travels as one row; flushSync paints that before the rows are measured.
    const folded: ReadonlySet<string> = wasOpen ? new Set([...collapsed, row.key]) : collapsed;
    if (wasOpen) flushSync(() => setCollapsed(folded));
    const blocks = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [])];
    const from = blocks.findIndex((b) => b.dataset["key"] === row.key);
    if (from < 0) return;
    const rects = blocks.map((b) => b.getBoundingClientRect());
    const gap = blocks.length > 1 ? Math.max(0, rects[1]!.top - rects[0]!.bottom) : 4;
    dragging.current = { key: row.key, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, from, target: from, depth: row.depth, slide: rects[from]!.height + gap, gap, blocks, mids: rects.map((r) => r.top + r.height / 2), heights: rects.map((r) => r.height), rows: flatten(tree, folded), wasOpen };
    setDragKey(row.key);
  }
  function onHandleMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragging.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const dy = e.clientY - d.startY; const dx = e.clientX - d.startX;
    const mid = d.mids[d.from]! + dy;
    let target = 0;
    for (let i = 0; i < d.mids.length; i++) if (i !== d.from && d.mids[i]! < mid) target++;
    const held = d.rows[d.from]!;
    const others = d.rows.filter((_, i) => i !== d.from);
    const { depth } = slotAt(others, target, Math.round(held.depth + dx / INDENT), held);
    if (target !== d.target || depth !== d.depth) (navigator as { vibrate?: (ms: number) => void }).vibrate?.(8);
    d.target = target; d.depth = depth;
    d.blocks.forEach((b, i) => {
      if (i === d.from) { b.style.transform = `translate3d(${(depth - held.depth) * INDENT + 12}px, ${dy}px, 0) scale(1.03)`; return; }
      const off = i < d.from ? (i >= target ? d.slide : 0) : (i <= target ? -d.slide : 0);
      b.style.transform = off ? `translate3d(0, ${off}px, 0)` : "";
    });
  }
  async function onHandleUp() {
    const d = dragging.current;
    dragging.current = null;
    if (!d) return;
    const held = d.rows[d.from]!;
    const others = d.rows.filter((_, i) => i !== d.from);
    const slot = slotAt(others, d.target, d.depth, held);
    const reopen = () => { if (d.wasOpen) setCollapsed((c) => { const n = new Set(c); n.delete(d.key); return n; }); };
    const currentIndex = (held.path.length > 1 ? findNodeIn(tree, held.path.slice(0, -1))?.children ?? [] : tree).findIndex((c) => samePath([...held.path.slice(0, -1), c.name], held.path));
    if (samePath(slot.parent, held.path.slice(0, -1)) && slot.index === currentIndex) {
      for (const b of d.blocks) b.style.transform = "";
      setDragKey(null); reopen();
      return;
    }
    let next;
    try { next = movePlaceTo(tree, held.path, slot.parent, slot.index); }
    catch (err) { for (const b of d.blocks) b.style.transform = ""; setDragKey(null); reopen(); fail(err); return; }
    // Snap the held card into the open slot at its new level; every transform stays until the new order paints.
    let snap = 0;
    if (d.target > d.from) for (let i = d.from + 1; i <= d.target; i++) snap += d.heights[i]! + d.gap;
    else for (let i = d.target; i < d.from; i++) snap -= d.heights[i]! + d.gap;
    const heldEl = d.blocks[d.from]!;
    heldEl.style.transition = "transform 0.15s ease";
    heldEl.style.transform = `translate3d(${(slot.depth - held.depth) * INDENT}px, ${snap}px, 0)`;
    const newPath = [...slot.parent, held.path[held.path.length - 1]!];
    const afterCollapsed = new Set(collapsed); afterCollapsed.add(d.key);
    pendingDrop.current = { keys: flatten(next, afterCollapsed).map((r) => r.key).join(), blocks: d.blocks };
    try {
      await savePlaceTree(next);
      if (!samePath(slot.parent, held.path.slice(0, -1))) {
        report(await rewriteDrawerPlaces(views, held.path, newPath));
      }
    } catch (err) { fail(err); }
    window.setTimeout(() => {
      const p = pendingDrop.current;
      if (p) { for (const b of p.blocks) { b.style.transition = ""; b.style.transform = ""; } pendingDrop.current = null; setDragKey(null); }
      // the moved branch keeps its old key only if its parent did not change; otherwise it opens under the new one
      if (d.wasOpen) setCollapsed((c) => { const n = new Set(c); n.delete(d.key); n.delete(pathKeyOf(newPath)); return n; });
    }, 160);
  }
  /* PETTY-130 (audit F23): ↑ ↓ move a place among its siblings from the keyboard; a live region says where it landed. */
  function onHandleKey(e: React.KeyboardEvent, r: FlatPlace) {
    const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const parent = r.path.slice(0, -1);
    const siblings = (parent.length ? findNodeIn(tree, parent)?.children : tree) ?? [];
    const i = siblings.findIndex((n) => n.name === r.node.name);
    const to = i + dir;
    if (i < 0 || to < 0 || to >= siblings.length) return;
    void savePlaceTree(shiftPlace(tree, r.path, dir)).then(() => setMoved(t("places.movedTo", { name: r.node.name, pos: to + 1, count: siblings.length })));
  }
  function onHandleCancel() {
    const d = dragging.current; dragging.current = null;
    if (!d) return;
    for (const b of d.blocks) b.style.transform = "";
    setDragKey(null);
    if (d.wasOpen) setCollapsed((c) => { const n = new Set(c); n.delete(d.key); return n; });
  }
  async function doRename(path: PlacePath, name: string) {
    const next = renamePlace(tree, path, name);
    await savePlaceTree(next);
    report(await rewriteDrawerPlaces(views, path, [...path.slice(0, -1), name.trim()]));
  }
  async function doMove(path: PlacePath, parent: PlacePath) {
    try {
      const next = movePlace(tree, path, parent);
      await savePlaceTree(next);
      report(await rewriteDrawerPlaces(views, path, [...parent, path[path.length - 1]!]));
    } catch (e) { fail(e); }
  }
  async function doDelete(path: PlacePath) {
    await savePlaceTree(removePlace(tree, path));
    report(await rewriteDrawerPlaces(views, path, path.slice(0, -1)));
  }
  const s = sheet;
  const name = s ? s.path[s.path.length - 1]! : "";
  // where the place stands among its siblings: the first cannot go up, nor the last down (PETTY-279)
  const siblings = s ? (s.path.length > 1 ? findNodeIn(tree, s.path.slice(0, -1))?.children ?? [] : tree) : [];
  const at = s ? siblings.findIndex((c) => samePath([...s.path.slice(0, -1), c.name], s.path)) : -1;
  return (
    <>
      <TopBar title={t("places.title")} onBack={back} />
      <main>
        <p className="sr-only" aria-live="polite" data-testid="move-announce">{moved}</p>
        <p className="hint mb12">{t("places.hint")} {t("places.dragHint")}</p>
        {rows.length === 0 ? <p className="empty" data-testid="places-empty">{t("places.empty")}</p> : null}
        <div className="tree" data-testid="places-tree" ref={treeRef}>
          {rows.map((r) => {
            const open = !collapsed.has(r.key);
            const n = count(r.path);
            const cls = `tree-row${dragKey === r.key ? " dragging" : ""}`;
            return (
              <div className={cls} key={r.key} style={{ "--depth": r.depth } as React.CSSProperties} data-testid="place-row" data-depth={r.depth} data-key={r.key}>
                {r.depth > 0 ? <span className="guide" aria-hidden="true" /> : null}
                <button type="button" className="tgrip" aria-label={t("places.drag", { name: r.node.name })} onPointerDown={(e) => onHandleDown(e, r)} onPointerMove={onHandleMove} onPointerUp={() => void onHandleUp()} onPointerCancel={onHandleCancel} onKeyDown={(e) => onHandleKey(e, r)}><GripVertical size={18} aria-hidden="true" /></button>
                {r.node.children.length ? (
                  <button type="button" className="tw" aria-expanded={open} aria-label={t(open ? "places.collapse" : "places.expand", { name: r.node.name })} onClick={() => toggle(r.key)}><ChevronRight size={18} aria-hidden="true" /></button>
                ) : <span className="tw" aria-hidden="true" />}
                {/* PETTY-143: name and count share one flexible cell; on a narrow row the count drops under the name instead of the name breaking mid-word. */}
                <span className="tmain">
                  <button type="button" className="tname" onClick={() => setSheet({ kind: "rename", path: r.path })} aria-label={t("places.rename") + ": " + r.node.name} data-testid="place-name">{r.node.name}</button>
                  {n ? <span className="tcount" data-testid="place-count">{t("places.count", { count: n })}</span> : null}
                </span>
                <button type="button" className="tbtn" aria-label={t("places.plus", { name: r.node.name })} onClick={() => setSheet({ kind: "add", path: r.path })} data-testid="place-plus"><Plus size={18} aria-hidden="true" /></button>
                <button type="button" className="tbtn" aria-label={t("places.minus", { name: r.node.name })} onClick={() => setSheet({ kind: "delete", path: r.path })} data-testid="place-minus"><Minus size={18} aria-hidden="true" /></button>
                <button type="button" className="opts-btn" aria-label={t("places.options", { name: r.node.name })} onClick={() => setSheet({ kind: "menu", path: r.path })}>⋯</button>
              </div>
            );
          })}
        </div>
        <button type="button" className="addbtn" onClick={() => setSheet({ kind: "add", path: [] })} data-testid="place-add-root">+ {t("places.add")}</button>
      </main>

      {s ? (
        <>
          <Sheet open={s.kind === "menu"} title={placeLabelOf(s.path)} onClose={() => setSheet(null)}>
            <div className="menu">
              <Button variant="secondary" onClick={() => setSheet({ kind: "add", path: s.path })} data-testid="place-add-inside">{t("places.addInside")}</Button>
              <Button variant="secondary" onClick={() => setSheet({ kind: "rename", path: s.path })}>{t("places.rename")}</Button>
              <Button variant="secondary" onClick={() => { setMoveTo(s.path.length > 1 ? s.path.slice(0, -1) : null); setSheet({ kind: "move", path: s.path }); }} data-testid="place-move">{t("places.move")}</Button>
              <Button variant="secondary" disabled={at <= 0} onClick={() => { setSheet(null); void savePlaceTree(shiftPlace(tree, s.path, -1)); }}>{t("places.moveUp")}</Button>
              <Button variant="secondary" disabled={at < 0 || at >= siblings.length - 1} onClick={() => { setSheet(null); void savePlaceTree(shiftPlace(tree, s.path, 1)); }}>{t("places.moveDown")}</Button>
              <Button variant="danger-ghost" onClick={() => setSheet({ kind: "delete", path: s.path })} data-testid="place-delete">{t("places.delete")}</Button>
            </div>
          </Sheet>
          <PromptSheet open={s.kind === "add"} title={s.path.length ? t("places.newHere", { parent: placeLabelOf(s.path) }) : t("places.newTop")} label={t("places.name")} onClose={() => setSheet(null)}
            validate={(v) => (v.trim() ? null : t("drawer.errors.nameRequired"))}
            onSave={async (v) => { try { await savePlaceTree(addPlace(tree, s.path, v).tree); } catch (e) { if (e instanceof PlaceExists) throw new Error(t("places.exists")); throw e; } }} />
          <PromptSheet open={s.kind === "rename"} title={t("places.renameTitle", { name })} label={t("places.name")} initial={name} onClose={() => setSheet(null)}
            validate={(v) => (v.trim() ? null : t("drawer.errors.nameRequired"))}
            onSave={async (v) => { try { await doRename(s.path, v); } catch (e) { if (e instanceof PlaceExists) throw new Error(t("places.exists")); throw e; } }} />
          <Sheet open={s.kind === "move"} title={t("places.moveTitle", { name })} onClose={() => setSheet(null)}>
            <PlacePicker tree={tree} value={moveTo} onChange={setMoveTo} exclude={s.path} emptyLabel={t("places.topLevel")} testId="move-picker" />
            <div className="actions">
              <Button variant="secondary" onClick={() => setSheet(null)}>{t("app.cancel")}</Button>
              {/* the parent it is in already is no move (movePlace would call it a name taken there) */}
              <Button onClick={async () => { setSheet(null); if (!samePath(moveTo ?? [], s.path.slice(0, -1))) await doMove(s.path, moveTo ?? []); }} data-testid="place-move-confirm">{t("app.save")}</Button>
            </div>
          </Sheet>
          <ConfirmSheet open={s.kind === "delete"} title={t("places.deleteTitle", { name })} body={t("places.deleteBody", { name, parent: s.path.length > 1 ? placeLabelOf(s.path.slice(0, -1)) : t("places.topLevel") })} confirmLabel={t("places.delete")} onClose={() => setSheet(null)}
            onConfirm={() => doDelete(s.path)} />
        </>
      ) : null}
    </>
  );
}
