import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ISO_4217, assertCurrencyCode, canChangeKind, lineCounted, lineTagsOf, type Line, type LineKind as Kind } from "@petty/ledger";
import { Button } from "./Button.js";
import { SwitchRow } from "./SwitchRow.js";
import { TagPicker } from "./TagPicker.js";
import { rememberTags, useTagIndex } from "../lib/lineTags.js";
import { ConfirmSheet } from "./ConfirmSheet.js";
import { PromptSheet } from "./PromptSheet.js";
import { Sheet } from "./Sheet.js";
import { useToast } from "./Toast.js";
import { IconPicker } from "../lib/icons.js";
import { ApiError } from "../lib/api.js";
import { deleteLine, mutateDocument, OpsNoLongerApply, type DrawerView } from "../lib/drawers.js";

export type LineOptionsStep = "options" | "rename" | "currency" | "unit" | "text" | "kind" | "icon" | "tags" | "delete";

/**
 * A line's options (PETTY-71): rename, icon, tags, part of the total, currency/unit/text, type, order,
 * delete. Reached from the line's own screen (⋯ in its top bar), the way a drawer's options are
 * reached from the drawer — not from the rows on the drawer screen. `line` is read fresh from the
 * view on every render, so the switch flips in place.
 */
export function LineOptions({ view, line, open, startAt = "options", onClose, onDeleted }: { view: DrawerView; line: Line; open: boolean; startAt?: LineOptionsStep; onClose: () => void; onDeleted?: () => void }) {
  const { t } = useTranslation();
  const place = view.doc?.lines.findIndex((l) => l.id === line.id) ?? -1;
  const lineCount = view.doc?.lines.length ?? 0;
  const toast = useToast();
  const [what, setWhat] = useState<LineOptionsStep>(startAt);
  useEffect(() => { if (open) setWhat(startAt); }, [open, startAt]);
  const canWrite = view.summary.role !== "read";
  const close = () => { onClose(); };
  async function run(fn: () => Promise<void>) {
    try { await fn(); } catch (e) {
      if (e instanceof OpsNoLongerApply) toast(t("drawer.errors.opsDropped"));
      else if (e instanceof ApiError && e.status === 403) toast(t("errors.unknown"));
      else toast(t("errors.unknown"));
    }
  }
  // PETTY-152: the picker offers my whole tag list, across drawers
  const { tags: myTags } = useTagIndex();
  if (!open) return null;
  return (
    <>
  <>
    <Sheet open={what === "options"} title={t("drawer.lineOptions", { name: line.name })} onClose={() => close()}>
      <div className="menu">
        {canWrite ? (
          <SwitchRow label={t("drawer.line.counted")} hint={t("drawer.line.countedHint")} checked={lineCounted(line)} onChange={(counted) => { void run(() => mutateDocument(view.summary.id, [{ type: "set_line_counted", line_id: line.id, counted }])); }} testId="line-counted-switch" />
        ) : null}
        {canWrite ? <Button variant="secondary" onClick={() => setWhat("rename")}>{t("drawer.line.rename")}</Button> : null}
        {canWrite ? <Button variant="secondary" onClick={() => setWhat("icon")} data-testid="line-icon">{t("drawer.line.icon")}</Button> : null}
        {canWrite ? <Button variant="secondary" onClick={() => setWhat("tags")} data-testid="line-tags-btn">{t("drawer.line.tags")}</Button> : null}
        {canWrite && line.kind === "money" ? <Button variant="secondary" onClick={() => setWhat("currency")}>{t("drawer.line.changeCurrency")}</Button> : null}
        {canWrite && line.kind === "countable" ? <Button variant="secondary" onClick={() => setWhat("unit")}>{t("drawer.line.changeUnit")}</Button> : null}
        {canWrite && line.kind === "single" ? <Button variant="secondary" onClick={() => setWhat("text")}>{t("drawer.line.editText")}</Button> : null}
        {canWrite && line.kind !== "single" ? (() => {
          const locked = !canChangeKind(line, (view.entries.get(line.id)?.length ?? 0) > 0);
          return (
            <>
              <Button variant="secondary" disabled={locked} onClick={() => setWhat("kind")}>{t("drawer.line.changeKind")}</Button>
              {/* PETTY-136 (audit F29): a disabled item says why, on screen, not only in a tooltip. */}
              {locked ? <p className="hint m0 mt4 fs13" data-testid="kind-locked">{t("drawer.line.kindLocked")}</p> : null}
            </>
          );
        })() : null}
        {/* PETTY-279: the first item cannot go up, nor the last one down */}
        {canWrite ? <Button variant="secondary" disabled={place === 0} onClick={() => { close(); void run(() => mutateDocument(view.summary.id, [{ type: "move_up", line_id: line.id }])); }}>{t("drawer.line.moveUp")}</Button> : null}
        {canWrite ? <Button variant="secondary" disabled={place === lineCount - 1} onClick={() => { close(); void run(() => mutateDocument(view.summary.id, [{ type: "move_down", line_id: line.id }])); }}>{t("drawer.line.moveDown")}</Button> : null}
        {canWrite ? <Button variant="danger-ghost" onClick={() => setWhat("delete")}>{t("drawer.line.delete")}</Button> : null}
      </div>
    </Sheet>
    <Sheet open={what === "icon"} title={t("drawer.line.icon")} onClose={() => close()}>
      <IconPicker value={line.icon ?? null} testId="line-icon-picker" onPick={(icon) => { close(); void run(() => mutateDocument(view.summary.id, [{ type: "set_line_icon", line_id: line.id, icon }])); }} />
    </Sheet>
    <TagPicker open={what === "tags"} title={t("drawer.line.tags")} value={lineTagsOf(line)} known={myTags.map((x) => x.label)} onClose={() => close()}
      onSave={(tags) => run(async () => { await mutateDocument(view.summary.id, [{ type: "set_line_tags", line_id: line.id, tags: [...tags] }]); await rememberTags(tags); })} />
    <PromptSheet open={what === "rename"} title={t("drawer.line.rename")} label={t("drawer.fields.name")} initial={line.name} onClose={() => close()}
      validate={(v) => (v.trim() ? null : t("drawer.errors.nameRequired"))} onSave={(v) => run(() => mutateDocument(view.summary.id, [{ type: "rename_line", line_id: line.id, name: v }]))} />
    <PromptSheet open={what === "currency"} title={t("drawer.line.changeCurrency")} label={t("drawer.fields.currency")} initial={line.kind === "money" ? line.currency : ""} list="iso-currencies-edit" hint={t("drawer.fields.currencyHint")} onClose={() => close()}
      validate={(v) => { try { assertCurrencyCode(v); return null; } catch { return t("drawer.errors.currencyRequired"); } }} onSave={(v) => run(() => mutateDocument(view.summary.id, [{ type: "set_currency", line_id: line.id, currency: v }]))} />
    <datalist id="iso-currencies-edit">{ISO_4217.map((c) => <option key={c.code} value={c.code} />)}</datalist>
    <PromptSheet open={what === "unit"} title={t("drawer.line.changeUnit")} label={t("drawer.fields.unit")} initial={line.kind === "countable" ? line.unit : ""} onClose={() => close()}
      onSave={(v) => run(() => mutateDocument(view.summary.id, [{ type: "set_unit", line_id: line.id, unit: v }]))} />
    <PromptSheet open={what === "text"} title={line.name} label={t("drawer.fields.text")} initial={line.kind === "single" ? line.text : ""} onClose={() => close()}
      onSave={(v) => (canWrite ? run(() => mutateDocument(view.summary.id, [{ type: "set_text", line_id: line.id, text: v }])) : undefined)} />
    <Sheet open={what === "kind"} title={t("drawer.line.changeKind")} onClose={() => close()}>
      <div className="menu">
        {(["money", "countable", "single"] as Kind[]).filter((k) => k !== line.kind).map((k) => (
          <Button key={k} variant="secondary" onClick={() => { close(); const base = { id: line.id, name: line.name }; const next: Line = k === "money" ? { ...base, kind: "money", currency: "EUR", exponent: 2 } : k === "countable" ? { ...base, kind: "countable", unit: "" } : { ...base, kind: "single", text: "" }; void run(() => mutateDocument(view.summary.id, [{ type: "change_kind", line_id: line.id, line: next }])); }}>{t(`drawer.kind.${k}`)}</Button>
        ))}
      </div>
    </Sheet>
    <ConfirmSheet open={what === "delete"} title={t("drawer.line.deleteConfirm", { name: line.name })}
      body={(view.entries.get(line.id)?.length ?? 0) > 0 ? t("drawer.line.deleteHistory", { count: view.entries.get(line.id)?.length ?? 0 }) : t("drawer.line.deleteNoHistory")}
      confirmLabel={t("drawer.deleteBtn")} onClose={() => close()} onConfirm={async () => { await run(() => deleteLine(view.summary.id, line.id)); onDeleted?.(); }} />
  </>    </>
  );
}
