import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight } from "lucide-react";
import { Button } from "./Button.js";
import { TextField } from "./TextField.js";
import { flatten, isPrefix, PlaceExists, pathKey, placeLabelOf, samePath, type PlaceNode, type PlacePath } from "../lib/places.js";

interface Props {
  tree: readonly PlaceNode[];
  value: PlacePath | null;
  onChange: (path: PlacePath | null) => void;
  /** A node (and everything under it) that cannot be chosen: the node being moved. */
  exclude?: PlacePath | null;
  /** The empty choice: "No place" (a drawer) or "Top level" (a move target). */
  emptyLabel: string;
  /** When given, a field under the tree creates a place inside the chosen one (or at the top) and selects it. */
  onCreate?: (parent: PlacePath, name: string) => Promise<PlacePath>;
  testId?: string;
}

/** The tree as a list of rows: chevrons fold branches, one row is pressed (PETTY-66). */
export function PlacePicker({ tree, value, onChange, exclude = null, emptyLabel, onCreate, testId = "place-picker" }: Props) {
  const { t } = useTranslation();
  // PETTY-125 (audit F18): a tree taller than the sheet (more than 8 rows) starts folded, except the branch that holds the current
  // value; a small tree stays fully open. Picking a place opens its branch.
  const withChildren = (nodes: readonly PlaceNode[], prefix: PlacePath = []): string[] => nodes.flatMap((n) => (n.children.length ? [pathKey([...prefix, n.name]), ...withChildren(n.children, [...prefix, n.name])] : []));
  const ancestors = (p: PlacePath | null) => new Set((p ?? []).map((_, i) => pathKey(p!.slice(0, i + 1))));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => { if (flatten(tree).length <= 8) return new Set(); const a = ancestors(value); return new Set(withChildren(tree).filter((k) => !a.has(k))); });
  useEffect(() => { const a = ancestors(value); setCollapsed((c) => { const n = new Set(c); for (const k of a) n.delete(k); return n; }); }, [value]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = flatten(tree, collapsed).filter((r) => !exclude || !isPrefix(r.path, exclude));
  const toggle = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  /** Not a <form>: the picker sits inside the Add drawer form, and nested forms are dropped by the browser (PETTY-105). Enter in the field creates the place. */
  async function create() {
    if (!onCreate || !name.trim() || busy) return;
    setBusy(true); setError(null);
    try { onChange(await onCreate(value ?? [], name)); setName(""); }
    catch (err) { setError(err instanceof PlaceExists ? t("places.exists") : t("errors.unknown")); }
    finally { setBusy(false); }
  }
  return (
    <div className="tree" data-testid={testId}>
      {onCreate ? (
        <div className="tree-new" role="group" aria-label={t("places.add")}>
          <TextField label={value && value.length ? t("places.newHere", { parent: placeLabelOf(value) }) : t("places.newTop")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); void create(); } }} error={error} autoComplete="off" data-testid="place-new" />
          <Button type="button" variant="secondary" busy={busy} disabled={!name.trim()} onClick={() => { void create(); }}>{t("places.add")}</Button>
        </div>
      ) : null}
      <div className={`tree-row${value === null ? " selected" : ""}`} style={{ "--depth": 0 } as React.CSSProperties}>
        <span className="tw" aria-hidden="true" />
        <button type="button" className="tname" aria-pressed={value === null} onClick={() => onChange(null)} data-testid="place-option" data-path="">{emptyLabel}</button>
        {value === null ? <Check size={18} className="tcheck" aria-hidden="true" /> : null}
      </div>
      {rows.map((r) => {
        const picked = value !== null && samePath(value, r.path);
        const open = !collapsed.has(r.key);
        return (
          <div className={`tree-row${picked ? " selected" : ""}`} key={r.key} style={{ "--depth": r.depth } as React.CSSProperties} data-testid="place-row">
            {r.depth > 0 ? <span className="guide" aria-hidden="true" /> : null}
            {r.node.children.length ? (
              <button type="button" className="tw" aria-expanded={open} aria-label={t(open ? "places.collapse" : "places.expand", { name: r.node.name })} onClick={() => toggle(r.key)}><ChevronRight size={18} aria-hidden="true" /></button>
            ) : <span className="tw" aria-hidden="true" />}
            <button type="button" className="tname" aria-pressed={picked} onClick={() => onChange(r.path)} data-testid="place-option" data-path={pathKey(r.path)}>{r.node.name}</button>
            {picked ? <Check size={18} className="tcheck" aria-hidden="true" /> : null}
          </div>
        );
      })}
    </div>
  );
}
