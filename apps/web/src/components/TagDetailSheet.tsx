import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { TagHolder, TagInfo } from "../lib/lineTags.js";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";

interface Props {
  open: boolean;
  tag: TagInfo | null;
  holders: readonly TagHolder[];
  onClose: () => void;
  onOpenItem: (drawerId: string) => void;
  onChoose: () => void;
  onRename: () => void;
  onRemove: () => void;
}

/**
 * One tag (PETTY-155): the items carrying it, by drawer, each opening its drawer with the tag filter on;
 * then the actions, stacked, the destructive one last. A drawer I can only read is marked so.
 */
export function TagDetailSheet({ open, tag, holders, onClose, onOpenItem, onChoose, onRename, onRemove }: Props) {
  const { t } = useTranslation();
  return (
    <Sheet open={open && !!tag} title={tag?.label ?? ""} onClose={onClose}>
      <div data-testid="tag-detail">
        {holders.length === 0 ? <p className="hint" data-testid="tag-detail-empty">{t("drawer.tagNoItemsYetLong")}</p> : holders.map((h) => (
          <section key={h.drawerId} className="tag-holder" data-testid="tag-detail-drawer">
            <h3 className="tag-holder-h">{h.drawerName}{h.writable ? null : <span className="hint m0"> · {t("drawer.tagDetailReadOnly")}</span>}</h3>
            <ul className="m0 p0">
              {h.lines.map((l) => (
                <li key={l.id} className="tag-holder-item">
                  <button type="button" className="tag-row-btn" onClick={() => onOpenItem(h.drawerId)} aria-label={t("drawer.tagOpenItem", { item: l.name, drawer: h.drawerName })}>
                    <span className="tag-row-main"><span className="tag-row-title">{l.name}</span></span>
                    <ChevronRight size={18} aria-hidden="true" className="tag-row-chev" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <div className="menu mt12">
            <Button variant="secondary" onClick={onChoose} data-testid="tag-detail-choose">{t("drawer.tagChooseItems")}</Button>
            <Button variant="secondary" onClick={onRename} data-testid="tag-detail-rename">{t("drawer.tagRename")}</Button>
            <Button variant="danger-ghost" onClick={onRemove} data-testid="tag-detail-remove">{t("drawer.tagRemove")}</Button>
        </div>
        <div className="actions"><Button variant="secondary" onClick={onClose}>{t("app.back")}</Button></div>
      </div>
    </Sheet>
  );
}
