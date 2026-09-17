import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.js";
import { Sheet } from "./Sheet.js";
import { TextField } from "./TextField.js";

interface SecondField { label: string; placeholder?: string; hint?: string; list?: string; initial?: string }
interface Props {
  open: boolean; title: string; label: string; initial?: string; placeholder?: string; hint?: string; list?: string;
  /** An optional second, free-text field (PETTY-54: tags when adding a drawer). Its value is the second argument of onSave. */
  second?: SecondField;
  onClose: () => void; onSave: (value: string, second: string) => Promise<void> | void; validate?: (v: string) => string | null;
}
/** One- or two-field sheet used for rename, currency, unit, text, add drawer. Browser autofill is off: these are never addresses or passwords. */
export function PromptSheet({ open, title, label, initial = "", placeholder, hint, list, second, onClose, onSave, validate }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [secondValue, setSecondValue] = useState(second?.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setValue(initial); setSecondValue(second?.initial ?? ""); setError(null); } }, [open, initial, second?.initial]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validate ? validate(value) : null;
    if (problem) { setError(problem); return; }
    setBusy(true);
    try { await onSave(value, secondValue); onClose(); } catch (err) { setError(err instanceof Error ? err.message : t("errors.unknown")); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <TextField label={label} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} hint={hint} error={error} list={list} autoComplete="off" autoFocus />
        {second ? <TextField label={second.label} value={secondValue} onChange={(e) => setSecondValue(e.target.value)} placeholder={second.placeholder} hint={second.hint} list={second.list} autoComplete="off" /> : null}
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
          <Button type="submit" busy={busy}>{t("app.save")}</Button>
        </div>
      </form>
    </Sheet>
  );
}
