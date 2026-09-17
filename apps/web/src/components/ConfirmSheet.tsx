import { useState } from "react";
import { useTranslation } from "react-i18next";
import { foldText } from "@petty/ledger";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";
import { TextField } from "./TextField.js";
import { useToast } from "./Toast.js";
import { Copy } from "lucide-react";

/** `challenge` (PETTY-62): the confirm button stays disabled until the typed text matches `expected` (case and spacing ignored). */
interface Challenge { label: string; expected: string; testId?: string }
interface Props { open: boolean; title: string; body: string; confirmLabel: string; danger?: boolean; challenge?: Challenge; onClose: () => void; onConfirm: () => Promise<void> | void }
export function ConfirmSheet({ open, title, body, confirmLabel, danger = true, challenge, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const close = () => { setTyped(""); onClose(); };
  const same = (a: string, b: string) => foldText(a).replace(/\s+/g, " ").trim() === foldText(b).replace(/\s+/g, " ").trim();
  const matches = !challenge || same(typed, challenge.expected);
  return (
    <Sheet open={open} title={title} onClose={close}>
      <p>{body}</p>
      {challenge ? (
        <>
          {/* The exact text to type, shown and copyable (PETTY-74): the friction is in the typing, not in guessing. */}
          <div className="challenge-text" data-testid="challenge-text">
            <code>{challenge.expected}</code>
            <button type="button" className="copy-btn" onClick={() => { void navigator.clipboard?.writeText(challenge.expected).then(() => toast(t("app.copied"))); }} aria-label={t("app.copy")}><Copy size={16} aria-hidden="true" />{t("app.copy")}</button>
          </div>
          <TextField label={challenge.label} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} data-testid={challenge.testId} />
        </>
      ) : null}
      <div className="actions">
        <Button variant="secondary" onClick={close}>{t("app.cancel")}</Button>
        <Button variant={danger ? "danger" : "primary"} busy={busy} disabled={!matches} onClick={async () => { setBusy(true); try { await onConfirm(); close(); } finally { setBusy(false); } }}>{confirmLabel}</Button>
      </div>
    </Sheet>
  );
}
