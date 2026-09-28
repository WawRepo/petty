import { foldText, placeLabel, tagsOf } from "@petty/ledger";
import { useEffect } from "react";
import { mutateDocument, useDrawers, type DrawerView, loadIfIdle } from "./drawers.js";
import { placesTree, setPlacesTree, usePins } from "./pins.js";

/**
 * Places as a tree (PETTY-66): clubhouse → pool area → locker 12. A drawer points at ONE node by
 * storing the node's path of names in its document (the `tags` array, PETTY-59), so the wire format
 * and every member's view are unchanged. The tree itself is this person's, in the encrypted user
 * document; paths found on drawers but missing from the tree are merged in on read, so nothing a
 * member typed elsewhere ever disappears. Names are unique among siblings by foldText.
 */
export interface PlaceNode { readonly name: string; readonly children: readonly PlaceNode[] }
export type PlacePath = readonly string[];
export const placeLabelOf = (p: PlacePath) => placeLabel(p);

const same = (a: string, b: string) => foldText(a) === foldText(b);
export const isPrefix = (path: PlacePath, prefix: PlacePath) => prefix.length <= path.length && prefix.every((p, i) => same(path[i]!, p));
export const samePath = (a: PlacePath, b: PlacePath) => a.length === b.length && isPrefix(a, b);

export function findNode(tree: readonly PlaceNode[], path: PlacePath): PlaceNode | null {
  let nodes = tree; let node: PlaceNode | null = null;
  for (const name of path) { node = nodes.find((n) => same(n.name, name)) ?? null; if (!node) return null; nodes = node.children; }
  return node;
}

/** The tree with every path added that it did not have yet (first spelling wins). */
export function mergePaths(tree: readonly PlaceNode[], paths: readonly PlacePath[]): readonly PlaceNode[] {
  let out = tree;
  for (const p of paths) for (let i = 1; i <= p.length; i++) if (!findNode(out, p.slice(0, i))) out = insert(out, p.slice(0, i - 1), { name: p[i - 1]!, children: [] });
  return out;
}

function update(tree: readonly PlaceNode[], path: PlacePath, f: (children: readonly PlaceNode[]) => readonly PlaceNode[]): readonly PlaceNode[] {
  if (path.length === 0) return f(tree);
  return tree.map((n) => (same(n.name, path[0]!) ? { ...n, children: update(n.children, path.slice(1), f) } : n));
}
function insert(tree: readonly PlaceNode[], parent: PlacePath, node: PlaceNode): readonly PlaceNode[] {
  return update(tree, parent, (c) => [...c, node]);
}

export class PlaceExists extends Error { constructor() { super("PlaceExists"); this.name = "PlaceExists"; } }

export function addPlace(tree: readonly PlaceNode[], parent: PlacePath, name: string): { tree: readonly PlaceNode[]; path: PlacePath } {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) throw new Error("PlaceNameRequired");
  const siblings = parent.length ? findNode(tree, parent)?.children ?? [] : tree;
  if (siblings.some((s) => same(s.name, n))) throw new PlaceExists();
  return { tree: insert(tree, parent, { name: n, children: [] }), path: [...parent, n] };
}

export function renamePlace(tree: readonly PlaceNode[], path: PlacePath, name: string): readonly PlaceNode[] {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) throw new Error("PlaceNameRequired");
  const parent = path.slice(0, -1);
  const siblings = parent.length ? findNode(tree, parent)?.children ?? [] : tree;
  if (siblings.some((s) => same(s.name, n) && !same(s.name, path[path.length - 1]!))) throw new PlaceExists();
  return update(tree, parent, (c) => c.map((s) => (same(s.name, path[path.length - 1]!) ? { ...s, name: n } : s)));
}

/** Removes the node; its children move up into its parent (nothing is lost). */
export function removePlace(tree: readonly PlaceNode[], path: PlacePath): readonly PlaceNode[] {
  const parent = path.slice(0, -1);
  const last = path[path.length - 1]!;
  return update(tree, parent, (c) => c.flatMap((s) => (same(s.name, last) ? s.children.filter((ch) => !c.some((o) => !same(o.name, last) && same(o.name, ch.name))) : [s])));
}

/** Moves a node (with everything under it) under a new parent, or to the top level with []. */
export function movePlace(tree: readonly PlaceNode[], path: PlacePath, newParent: PlacePath): readonly PlaceNode[] {
  if (isPrefix(newParent, path)) throw new Error("PlaceIntoItself");
  const node = findNode(tree, path);
  if (!node) return tree;
  const target = newParent.length ? findNode(tree, newParent)?.children ?? [] : tree;
  if (target.some((s) => same(s.name, node.name))) throw new PlaceExists();
  const without = update(tree, path.slice(0, -1), (c) => c.filter((s) => !same(s.name, node.name)));
  return insert(without, newParent, node);
}

/**
 * Drag-and-drop (PETTY-67): put the node at `index` among the children of `newParent` ([] = top level).
 * The index counts the siblings WITHOUT the moved node, so a drop before/after a neighbour lands where
 * the finger was. Into itself or a descendant is refused; a same-named sibling at the target too.
 */
export function movePlaceTo(tree: readonly PlaceNode[], path: PlacePath, newParent: PlacePath, index: number): readonly PlaceNode[] {
  if (isPrefix(newParent, path)) throw new Error("PlaceIntoItself");
  const node = findNode(tree, path);
  if (!node) return tree;
  const without = update(tree, path.slice(0, -1), (c) => c.filter((s) => !same(s.name, node.name)));
  const target = newParent.length ? findNode(without, newParent)?.children ?? [] : without;
  if (target.some((s) => same(s.name, node.name))) throw new PlaceExists();
  return update(without, newParent, (c) => { const out = [...c]; out.splice(Math.max(0, Math.min(c.length, index)), 0, node); return out; });
}

export function shiftPlace(tree: readonly PlaceNode[], path: PlacePath, dir: -1 | 1): readonly PlaceNode[] {
  const last = path[path.length - 1]!;
  return update(tree, path.slice(0, -1), (c) => {
    const i = c.findIndex((s) => same(s.name, last)); const j = i + dir;
    if (i < 0 || j < 0 || j >= c.length) return c;
    const out = [...c]; [out[i], out[j]] = [out[j]!, out[i]!]; return out;
  });
}

export interface FlatPlace { readonly path: PlacePath; readonly node: PlaceNode; readonly depth: number; readonly key: string }
export const pathKey = (p: PlacePath) => p.map(foldText).join("\0");
export function flatten(tree: readonly PlaceNode[], collapsed: ReadonlySet<string> = new Set(), prefix: PlacePath = []): FlatPlace[] {
  return tree.flatMap((n) => {
    const path = [...prefix, n.name]; const key = pathKey(path);
    return [{ path, node: n, depth: prefix.length, key }, ...(collapsed.has(key) ? [] : flatten(n.children, collapsed, path))];
  });
}

/**
 * Rewrites in flight (PETTY-69). A rename or move rewrites the drawers under the node one by one, each
 * an encrypted write; until the last one lands, the merge on read would put the OLD branch back with
 * the drawers still on it. So every reader maps a drawer's path through the pending rewrites first
 * and sees the new place at once; the map empties when the writes are done.
 */
const pendingRewrites: { from: PlacePath; to: PlacePath }[] = [];
export function effectivePlace(path: PlacePath): PlacePath {
  let p = path;
  for (const r of pendingRewrites) if (isPrefix(p, r.from)) p = [...r.to, ...p.slice(r.from.length)];
  return p;
}
export const placeOfView = (v: DrawerView): PlacePath => (v.doc ? effectivePlace(tagsOf(v.doc)) : []);

/** The tree to show: what this person saved, plus every path a drawer carries. */
export function usePlaceTree(): readonly PlaceNode[] {
  const drawers = useDrawers();
  const doc = usePins().doc;
  // Opened directly (a reload on /places): load the drawers — and with them the user document that holds the tree.
  useEffect(() => { if (drawers.status === "idle") loadIfIdle(); }, [drawers.status]);
  return mergePaths(placesTree(doc), [...drawers.drawers.values()].map(placeOfView).filter((p) => p.length));
}

/** Drawers (I can see) whose place is this node or below it. */
export function drawersUnder(views: Iterable<DrawerView>, path: PlacePath): DrawerView[] {
  return [...views].filter((v) => v.doc && isPrefix(placeOfView(v), path));
}

export interface RewriteResult { readonly done: number; readonly failed: number; readonly readOnly: number }

/**
 * A rename or a move changes the path of every drawer under the node. Drawers I can write are
 * rewritten one by one (each is its own encrypted document); one that fails does not stop the rest.
 * A read-only shared drawer cannot be rewritten: it keeps its old path and the merge on read shows it
 * where it was — the count says so.
 */
export async function rewriteDrawerPlaces(views: Iterable<DrawerView>, oldPrefix: PlacePath, newPrefix: PlacePath): Promise<RewriteResult> {
  const pending = { from: oldPrefix, to: newPrefix };
  pendingRewrites.push(pending);
  let done = 0, failed = 0, readOnly = 0;
  try {
    for (const v of views) {
      if (!v.doc) continue;
      const p = tagsOf(v.doc);
      if (!isPrefix(p, oldPrefix)) continue;
      if (v.summary.role === "read") { readOnly++; continue; }
      try { await mutateDocument(v.summary.id, [{ type: "set_tags", tags: [...newPrefix, ...p.slice(oldPrefix.length)] }]); done++; }
      catch { failed++; }
    }
  } finally {
    pendingRewrites.splice(pendingRewrites.indexOf(pending), 1);
  }
  return { done, failed, readOnly };
}

export async function savePlaceTree(tree: readonly PlaceNode[]): Promise<void> { await setPlacesTree(tree); }
