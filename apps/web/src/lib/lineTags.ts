/**
 * Item tags per person (PETTY-152). The tags on an item stay in the drawer document, shared by every
 * member. The list of tags is this person's: saved in the encrypted user document and merged on read
 * with every tag found on a drawer I can read, the way places work. A rename or a removal rewrites the
 * tag on every drawer I can write, one encrypted write per drawer.
 */
import { foldText, lineTagsOf, MAX_TAGS, MAX_TAG_LENGTH, normalizeTags, type Line } from "@petty/ledger";
import { useEffect } from "react";
import { loadAll, useDrawers, mutateDocument, type DrawerView } from "./drawers.js";
import { savedLineTags, updateSavedLineTags, usePins } from "./pins.js";

/** Upper bound on the saved list; household scale, and it keeps the user document small. */
export const MAX_SAVED_TAGS = 200;

export interface TagInfo { readonly key: string; readonly label: string; readonly items: number; readonly drawers: number }
export interface TaggedItem { readonly drawerId: string; readonly drawerName: string; readonly writable: boolean; readonly line: Line }
export interface RewriteResult { readonly done: number; readonly failed: number; readonly readOnly: number }

export const cleanTag = (raw: string) => raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH).trim();

/** Every item of every drawer I can read, in drawer order; the given drawer first. */
export function allItems(views: Iterable<DrawerView>, firstDrawer?: string): TaggedItem[] {
  const out: TaggedItem[] = [];
  for (const v of views) {
    if (!v.doc) continue;
    for (const line of v.doc.lines) out.push({ drawerId: v.summary.id, drawerName: v.doc.name, writable: v.summary.role !== "read", line });
  }
  return firstDrawer ? [...out.filter((i) => i.drawerId === firstDrawer), ...out.filter((i) => i.drawerId !== firstDrawer)] : out;
}

/** The merged list: saved tags first in their spelling, then tags found only on drawers. Sorted by label. */
export function tagIndex(saved: readonly string[], items: readonly TaggedItem[]): TagInfo[] {
  const map = new Map<string, { label: string; items: number; drawers: Set<string> }>();
  for (const s of saved) { const k = foldText(s); if (k && !map.has(k)) map.set(k, { label: s, items: 0, drawers: new Set() }); }
  for (const it of items) for (const tg of lineTagsOf(it.line)) {
    const k = foldText(tg);
    const cur = map.get(k) ?? { label: tg, items: 0, drawers: new Set<string>() };
    cur.items++; cur.drawers.add(it.drawerId);
    map.set(k, cur);
  }
  return [...map.entries()].map(([key, v]) => ({ key, label: v.label, items: v.items, drawers: v.drawers.size })).sort((a, b) => a.label.localeCompare(b.label));
}

export function useTagIndex(firstDrawer?: string): { tags: TagInfo[]; items: TaggedItem[]; views: DrawerView[] } {
  const drawers = useDrawers();
  const doc = usePins().doc;
  // opened from Settings after a reload: load the drawers, and with them the user document
  useEffect(() => { if (drawers.status === "idle") void loadAll(); }, [drawers.status]);
  const views = [...drawers.drawers.values()];
  const items = allItems(views, firstDrawer);
  return { tags: tagIndex(savedLineTags(doc), items), items, views };
}

/** Add tags to the saved list (a tag typed on an item is remembered even after the item drops it). */
export async function rememberTags(tags: readonly string[]): Promise<void> {
  const saved = savedLineTags();
  const fresh = tags.map(cleanTag).filter((t) => t && !saved.some((s) => foldText(s) === foldText(t)));
  if (!fresh.length) return;
  await updateSavedLineTags((cur) => dedupe([...cur, ...fresh]).slice(0, MAX_SAVED_TAGS));
}

function dedupe(tags: readonly string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const t of tags) { const k = foldText(t); if (!k || seen.has(k)) continue; seen.add(k); out.push(t); }
  return out;
}

/** Apply `change` to the tags of every item carrying `key`, on every drawer I can write. */
async function rewrite(views: Iterable<DrawerView>, key: string, change: (tag: string) => string | null): Promise<RewriteResult> {
  let done = 0, failed = 0, readOnly = 0;
  for (const v of views) {
    if (!v.doc) continue;
    const ops = v.doc.lines.flatMap((l) => {
      const cur = lineTagsOf(l);
      if (!cur.some((x) => foldText(x) === key)) return [];
      const next = normalizeTags(cur.flatMap((x) => { if (foldText(x) !== key) return [x]; const r = change(x); return r === null ? [] : [r]; }));
      return [{ type: "set_line_tags" as const, line_id: l.id, tags: [...next] }];
    });
    if (!ops.length) continue;
    if (v.summary.role === "read") { readOnly++; continue; }
    try { await mutateDocument(v.summary.id, ops); done++; } catch { failed++; }
  }
  return { done, failed, readOnly };
}

/** Rename a tag everywhere I can; a name that already exists merges the two (its spelling wins). */
export async function renameTag(views: Iterable<DrawerView>, key: string, rawName: string): Promise<RewriteResult> {
  const name = cleanTag(rawName);
  const newKey = foldText(name);
  const existing = savedLineTags().find((s) => foldText(s) === newKey);
  const spelled = key !== newKey && existing ? existing : name;
  await updateSavedLineTags((cur) => dedupe(cur.map((s) => (foldText(s) === key ? spelled : s)).concat(cur.some((s) => foldText(s) === key) ? [] : [spelled])));
  return rewrite(views, key, () => spelled);
}

/** Remove a tag from the list and from every item I can write. */
export async function removeTag(views: Iterable<DrawerView>, key: string): Promise<RewriteResult> {
  await updateSavedLineTags((cur) => cur.filter((s) => foldText(s) !== key));
  return rewrite(views, key, () => null);
}

/** Make a tag (it may carry no items yet) and set which items carry it. `picked` holds `drawerId:lineId`. */
export async function setTagItems(items: readonly TaggedItem[], rawName: string, picked: ReadonlySet<string>): Promise<RewriteResult> {
  const name = cleanTag(rawName);
  const key = foldText(name);
  await rememberTags([name]);
  const spelled = savedLineTags().find((s) => foldText(s) === key) ?? name;
  const byDrawer = new Map<string, { type: "set_line_tags"; line_id: string; tags: string[] }[]>();
  for (const it of items) {
    if (!it.writable) continue;
    const cur = lineTagsOf(it.line);
    const has = cur.some((x) => foldText(x) === key);
    const want = picked.has(itemId(it));
    if (has === want || (want && cur.length >= MAX_TAGS)) continue;
    const next = want ? normalizeTags([...cur, spelled]) : normalizeTags(cur.filter((x) => foldText(x) !== key));
    byDrawer.set(it.drawerId, [...(byDrawer.get(it.drawerId) ?? []), { type: "set_line_tags", line_id: it.line.id, tags: [...next] }]);
  }
  let done = 0, failed = 0;
  for (const [id, ops] of byDrawer) { try { await mutateDocument(id, ops); done++; } catch { failed++; } }
  return { done, failed, readOnly: 0 };
}

export const itemId = (it: TaggedItem) => `${it.drawerId}:${it.line.id}`;

export interface TagHolder { readonly drawerId: string; readonly drawerName: string; readonly writable: boolean; readonly lines: readonly Line[] }
/** The items carrying `key`, grouped by drawer in the order of `items` (PETTY-155). */
export function tagHolders(key: string, items: readonly TaggedItem[]): TagHolder[] {
  const out: { drawerId: string; drawerName: string; writable: boolean; lines: Line[] }[] = [];
  for (const it of items) {
    if (!lineTagsOf(it.line).some((x) => foldText(x) === key)) continue;
    const g = out.find((x) => x.drawerId === it.drawerId);
    if (g) g.lines.push(it.line); else out.push({ drawerId: it.drawerId, drawerName: it.drawerName, writable: it.writable, lines: [it.line] });
  }
  return out;
}
