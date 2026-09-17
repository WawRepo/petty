import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { ChevronRight } from "lucide-react";
import { foldText } from "@petty/ledger";
import { cleanTag, removeTag, renameTag, tagHolders, useTagIndex, type RewriteResult, type TagHolder } from "../lib/lineTags.js";
import { Button } from "./Button.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { PromptSheet } from "./PromptSheet.js";
import { Sheet } from "./Sheet.js";
import { TagDetailSheet } from "./TagDetailSheet.js";
import { TagItemsSheet } from "./TagItemsSheet.js";
import { useToast } from "./Toast.js";

interface Props { open: boolean; onClose: () => void; /** opened from a drawer: its items come first */ drawerId?: string }

type Step = null | "detail" | "choose" | "rename" | "merge" | "remove" | "new";

/**
 * My item tags (PETTY-147/151/152/155). The list names the items each tag is on, by drawer; a row opens
 * the tag: its items (each opens its drawer filtered by the tag), then Choose items, Rename, Remove tag.
 * Rename and remove act on every drawer I can write; renaming onto an existing tag asks before merging.
 */
export function TagManager({ open, onClose, drawerId }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const { tags, items, views } = useTagIndex(drawerId);
  const [key, setKey] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(null);
  const [merge, setMerge] = useState<{ from: string; to: string; name: string } | null>(null);
  const tag = key ? tags.find((x) => x.key === key) ?? null : null;
  const holders = key ? tagHolders(key, items) : [];
  const report = (r: RewriteResult) => {
    if (r.failed) toast(t("drawer.tagRewriteFailed", { count: r.failed }));
    else if (r.readOnly) toast(t("drawer.tagRewriteReadOnly", { count: r.readOnly }));
  };
  const summary = (hs: readonly TagHolder[]) => {
    if (!hs.length) return t("drawer.tagNoItemsYet");
    const part = (h: TagHolder) => {
      const names = h.lines.slice(0, 2).map((l) => l.name).join(", ");
      return `${h.drawerName}: ${names}${h.lines.length > 2 ? ` ${t("drawer.tagMore", { count: h.lines.length - 2 })}` : ""}`;
    };
    const rest = hs.slice(2).reduce((n, h) => n + h.lines.length, 0);
    return hs.slice(0, 2).map(part).join(" · ") + (rest ? ` · ${t("drawer.tagMore", { count: rest })}` : "");
  };
  const doRename = async (from: string, name: string) => { const r = await renameTag(views, from, name); setKey(foldText(cleanTag(name))); report(r); };
  const back = () => setStep("detail");
  return (
    <>
      <Sheet open={open && step === null} title={t("drawer.tagsManage")} onClose={onClose}>
        <p className="hint mt0">{t("drawer.tagsManageHint")}</p>
        {tags.length === 0 ? <p className="hint" data-testid="tag-manager-empty">{t("drawer.tagsEmpty")}</p> : (
          <ul className="m0 p0 tag-list" data-testid="tag-manager">
            {tags.map((v) => (
              <li key={v.key} data-testid="tag-manager-row">
                <button type="button" className="tag-row-btn" onClick={() => { setKey(v.key); setStep("detail"); }} aria-label={t("drawer.tagRowName", { tag: v.label, count: v.items })}>
                  <span className="tag-row-main">
                    <span className="tag-row-title">{v.label}</span>
                    <span className="tag-row-sub" data-testid="tag-manager-summary">{summary(tagHolders(v.key, items))}</span>
                  </span>
                  <ChevronRight size={18} aria-hidden="true" className="tag-row-chev" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>{t("app.close")}</Button>
          <Button onClick={() => { setKey(null); setStep("new"); }} data-testid="tag-manager-new">{t("drawer.tagNew")}</Button>
        </div>
      </Sheet>
      <TagDetailSheet open={open && step === "detail"} tag={tag} holders={holders} onClose={() => { setStep(null); setKey(null); }}
        onOpenItem={(id) => { setStep(null); onClose(); nav(`/drawers/${id}?tag=${encodeURIComponent(tag?.label ?? "")}`); }}
        onChoose={() => setStep("choose")} onRename={() => setStep("rename")} onRemove={() => setStep("remove")} />
      <TagItemsSheet open={open && (step === "choose" || step === "new")} tag={step === "choose" ? tag : null} items={items}
        onClose={() => (step === "new" ? setStep(null) : back())} onSaved={report} />
      <PromptSheet open={open && step === "rename"} title={t("drawer.tagRename")} label={t("drawer.tagNewName")} initial={tag?.label ?? ""}
        validate={(v) => (cleanTag(v) ? null : t("drawer.tagNameRequired"))}
        onClose={() => setStep((s) => (s === "rename" ? "detail" : s))}
        onSave={async (v) => {
          if (!tag) return;
          const to = tags.find((x) => x.key === foldText(cleanTag(v)) && x.key !== tag.key);
          if (to) { setMerge({ from: tag.label, to: to.label, name: v }); setStep("merge"); return; }
          await doRename(tag.key, v);
        }} />
      <ConfirmSheet open={open && step === "merge" && !!merge} title={t("drawer.tagMergeTitle")} danger={false}
        body={t("drawer.tagMergeConfirm", { from: merge?.from ?? "", to: merge?.to ?? "" })} confirmLabel={t("drawer.tagMerge")}
        onClose={() => { setMerge(null); setStep("detail"); }}
        onConfirm={async () => { if (merge && key) await doRename(key, merge.name); }} />
      <ConfirmSheet open={open && step === "remove"} title={t("drawer.tagRemove")}
        body={t("drawer.tagRemoveConfirm", { tag: tag?.label ?? "", count: tag?.items ?? 0 })}
        confirmLabel={t("drawer.tagRemove")} onClose={() => setStep((s) => (s === "remove" ? "detail" : s))}
        onConfirm={async () => { if (tag) { const k = tag.key; setKey(null); setStep(null); report(await removeTag(views, k)); } }} />
    </>
  );
}
