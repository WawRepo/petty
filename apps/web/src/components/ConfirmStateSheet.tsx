import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Verification, VerificationLine } from "@petty/ledger";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";
import { TextField } from "./TextField.js";
import { useToast } from "./Toast.js";
import { lineFold, mutateDocument, type DrawerView } from "../lib/drawers.js";
import { quantityLabel } from "../lib/format.js";
import { useAuth } from "../lib/session.js";

/**
 * The spec's "Confirm state" sheet: every line is listed — balances for money and
 * countables, a tick (default present) for single items — so a normal confirmation
 * is one tap, and an absent item is the only thing that needs a touch.
 */
export function ConfirmStateSheet({ open, view, onClose }: { open: boolean; view: DrawerView; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const auth = useAuth();
  const [comment, setComment] = useState("");
  const [absent, setAbsent] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setComment(""); setAbsent(new Set()); } }, [open]);
  const doc = view.doc;
  if (!doc) return null;
  const counted = doc.lines.filter((l) => l.kind !== "single");
  const singles = doc.lines.filter((l) => l.kind === "single");

  async function confirm() {
    if (auth.status !== "unlocked") return;
    setBusy(true);
    try {
      const lines: VerificationLine[] = doc!.lines.map((l) => {
        if (l.kind === "single") return { line_id: l.id, kind: l.kind, balance: null, present: !absent.has(l.id), head_seq: null };
        const f = lineFold(view, l.id);
        return { line_id: l.id, kind: l.kind, balance: f.balance, present: null, head_seq: f.headSeq };
      });
      const verification: Verification = { id: crypto.randomUUID(), author_id: auth.me.id, logged_at: new Date().toISOString(), comment: comment.trim(), lines };
      await mutateDocument(view.summary.id, [{ type: "append_verification", verification }], { verification: true });
      toast(t("verify.toast"));
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} title={t("verify.sheet.title")} onClose={onClose}>
      <p className="hint">{t("verify.sheet.hint")}</p>
      <div className="confirm-summary" data-testid="confirm-state-lines">
        {counted.length === 0 ? <div className="cline"><span className="k">{t("verify.sheet.lines")}</span><span>{t("verify.sheet.none")}</span></div> : null}
        {counted.map((l) => (
          <div className="cline" key={l.id}><span className="k">{l.name}</span><span>{quantityLabel(l, lineFold(view, l.id).balance, i18n.language, t)}</span></div>
        ))}
      </div>
      {singles.length ? (
        <fieldset className="confirm-summary fieldset-bordered">
          <legend className="hint hint legend">{t("verify.sheet.items")}</legend>
          {singles.map((l) => (
            <div className="cline" key={l.id}>
              <label htmlFor={`present-${l.id}`}>{l.name}</label>
              <input id={`present-${l.id}`} type="checkbox" checked={!absent.has(l.id)} aria-label={t("verify.sheet.present", { name: l.name })}
                onChange={(e) => { const next = new Set(absent); if (e.target.checked) next.delete(l.id); else next.add(l.id); setAbsent(next); }} />
            </div>
          ))}
        </fieldset>
      ) : null}
      <TextField label={t("verify.sheet.comment")} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("verify.sheet.commentPlaceholder")} maxLength={500} />
      <div className="actions">
        <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
        <Button busy={busy} onClick={() => void confirm()}>{t("verify.sheet.confirm")}</Button>
      </div>
    </Sheet>
  );
}
