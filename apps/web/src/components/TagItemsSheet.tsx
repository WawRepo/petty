import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { foldText, lineTagsOf, MAX_TAGS, MAX_TAG_LENGTH } from "@petty/ledger";
import { cleanTag, itemId, setTagItems, type RewriteResult, type TagInfo, type TaggedItem } from "../lib/lineTags.js";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";
import { TextField } from "./TextField.js";

interface Props {
  open: boolean;
  /** null: a new tag, its name is typed here; otherwise the tag whose items are picked */
  tag: TagInfo | null;
  /** every item I can read, the current drawer's first */
  items: readonly TaggedItem[];
  onClose: () => void;
  onSaved: (r: RewriteResult) => void;
}

/**
 * Make a tag, or choose which items carry one (PETTY-151/152). The tag list is per person, so a new tag
 * may carry no item yet. Items are grouped by drawer; only drawers I can write are offered. An item that
 * already has the maximum number of tags cannot take one more.
 */
export function TagItemsSheet({ open, tag, items, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = cleanTag(tag ? tag.label : name);
  const key = foldText(label);
  const carries = (it: TaggedItem) => lineTagsOf(it.line).some((x) => foldText(x) === key);
  useEffect(() => {
    if (!open) return;
    setName(""); setError(null);
    setPicked(new Set(tag ? items.filter((it) => lineTagsOf(it.line).some((x) => foldText(x) === tag.key)).map(itemId) : []));
  }, [open, tag?.key]);
  const writable = items.filter((it) => it.writable);
  const groups: { id: string; name: string; items: TaggedItem[] }[] = [];
  for (const it of writable) {
    const g = groups.find((x) => x.id === it.drawerId);
    if (g) g.items.push(it); else groups.push({ id: it.drawerId, name: it.drawerName, items: [it] });
  }

  async function save() {
    if (!label) { setError(t("drawer.tagNameRequired")); return; }
    setBusy(true);
    try { const r = await setTagItems(items, label, picked); onClose(); onSaved(r); } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} title={tag ? t("drawer.tagItemsTitle", { tag: tag.label }) : t("drawer.tagNewTitle")} onClose={onClose}>
      <div data-testid="tag-items">
        {tag ? null : (
          <TextField label={t("drawer.tagName")} value={name} maxLength={MAX_TAG_LENGTH} autoComplete="off" data-testid="tag-items-name"
            onChange={(e) => { setName(e.target.value); setError(null); }} />
        )}
        {groups.length === 0 ? <p className="hint">{t("drawer.tagNoItems")}</p> : (
          <>
            <p className="hint my6">{tag ? t("drawer.tagPickItems") : t("drawer.tagPickItemsOptional")}</p>
            {groups.map((g) => (
              <fieldset className="confirm-summary fieldset-bordered" key={g.id} data-testid="tag-items-drawer">
                <legend className="hint legend">{g.name}</legend>
                {g.items.map((it) => {
                  const id = itemId(it);
                  const on = picked.has(id);
                  const full = !carries(it) && lineTagsOf(it.line).length >= MAX_TAGS;
                  return (
                    <div className="cline" key={id}>
                      <label htmlFor={`tag-item-${id}`}>{it.line.name}{full ? <span className="hint m0"> · {t("drawer.tagItemFull", { max: MAX_TAGS })}</span> : null}</label>
                      <input id={`tag-item-${id}`} type="checkbox" checked={on} disabled={full && !on} aria-label={t("drawer.tagItemIn", { item: it.line.name, drawer: g.name })}
                        onChange={(e) => { const next = new Set(picked); if (e.target.checked) next.add(id); else next.delete(id); setPicked(next); }} />
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </>
        )}
        {items.some((it) => !it.writable) ? <p className="hint my6" data-testid="tag-items-readonly">{t("drawer.tagHiddenReadOnly")}</p> : null}
        {error ? <div className="error" role="alert">{error}</div> : null}
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
          <Button onClick={() => { void save(); }} busy={busy} data-testid="tag-items-save">{t("app.save")}</Button>
        </div>
      </div>
    </Sheet>
  );
}
