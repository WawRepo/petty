import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { foldText, MAX_TAGS, MAX_TAG_LENGTH, normalizeTags } from "@petty/ledger";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";
import { TagChip } from "./TagChip.js";
import { TextField } from "./TextField.js";

interface Props { open: boolean; title: string; value: readonly string[]; known: readonly string[]; onClose: () => void; onSave: (tags: readonly string[]) => Promise<void> | void }

/**
 * A line's tags as real tags (PETTY-147): the drawer's tags are chips to switch on or off, a new one is
 * typed into its own field and added with Enter, the 5-tag limit is visible. No comma-separated text.
 */
export function TagPicker({ open, title, value, known, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<readonly string[]>(value);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPicked(value); setDraft(""); } }, [open, value]);
  const has = (tag: string) => picked.some((p) => foldText(p) === foldText(tag));
  // every tag the drawer knows plus the ones picked here (a new tag shows up as a chip at once)
  const chips = dedupe([...known, ...picked]);
  const full = picked.length >= MAX_TAGS;
  const toggle = (tag: string) => setPicked(has(tag) ? picked.filter((p) => foldText(p) !== foldText(tag)) : full ? picked : normalizeTags([...picked, tag]));
  const add = () => {
    const tag = draft.replace(/\s+/g, " ").trim();
    if (!tag || full) return;
    setPicked(normalizeTags([...picked, tag]));
    setDraft("");
  };
  async function save() {
    setBusy(true);
    try { await onSave(picked); onClose(); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <div data-testid="tag-picker">
        {chips.length ? (
          <div className="tag-bar tag-picker-chips" role="group" aria-label={t("drawer.line.tagsKnown")}>
            {chips.map((c) => <TagChip key={foldText(c)} label={c} pressed={has(c)} onClick={() => toggle(c)} />)}
          </div>
        ) : <p className="hint">{t("drawer.line.tagsNone")}</p>}
        <TextField label={t("drawer.line.tagsNew")} value={draft} maxLength={MAX_TAG_LENGTH} disabled={full} autoComplete="off" data-testid="tag-new"
          hint={full ? t("drawer.line.tagsFull", { max: MAX_TAGS }) : t("drawer.line.tagsCount", { count: picked.length, max: MAX_TAGS })}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <p className="m0"><Button variant="ghost" onClick={add} disabled={!draft.trim() || full}>{t("drawer.line.tagsAdd")}</Button></p>
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
          <Button onClick={() => { void save(); }} busy={busy} data-testid="tag-save">{t("app.save")}</Button>
        </div>
      </div>
    </Sheet>
  );
}

function dedupe(tags: readonly string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of tags) { const tag = raw.trim(); const k = foldText(tag); if (!tag || seen.has(k)) continue; seen.add(k); out.push(tag); }
  return out.sort((a, b) => a.localeCompare(b));
}
