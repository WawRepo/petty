import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useDrawers } from "../lib/drawers.js";

/** Not chosen yet (null), every drawer and later ones too ("all"), or only the listed drawers. */
export type ScopeChoice = null | "all" | readonly string[];

/** What a token is made with: null for every drawer, or the chosen ids. Undefined while there is no valid choice. */
export function scopeOf(choice: ScopeChoice): readonly string[] | null | undefined {
  if (choice === "all") return null;
  return choice && choice.length ? choice : undefined;
}

interface Props { value: ScopeChoice; onChange: (next: ScopeChoice) => void; testId: string }
/**
 * Which drawers a new token may use (PETTY-452), in Settings and on the /device page. Nothing is chosen
 * for the person: "all drawers" is one of two choices they make. Native radios and checkboxes, so the
 * keyboard and a screen reader work as in any form; each is named by its title, and the hint is its
 * description (as in SwitchRow). Only drawers this device can open are offered, because only their keys
 * can go into a token.
 */
export function TokenScope({ value, onChange, testId }: Props) {
  const { t } = useTranslation();
  const name = useId();
  const drawers = [...useDrawers().drawers.values()].filter((v) => v.key && v.doc).map((v) => ({ id: v.summary.id, name: v.doc!.name }));
  const picked = value !== null && value !== "all" ? value : null;
  return (
    <fieldset className="fieldset-plain" data-testid={testId}>
      <legend className="hint mb6 fw600">{t("tokens.scope")}</legend>
      <label className="choice-row">
        <input type="radio" name={name} checked={value === "all"} onChange={() => onChange("all")} aria-labelledby={`${name}-all`} aria-describedby={`${name}-all-h`} data-testid={`${testId}-all`} />
        <span className="choice-body"><span className="choice-title" id={`${name}-all`}>{t("tokens.scopeAll")}</span><span className="hint m0" id={`${name}-all-h`}>{t("tokens.scopeAllHint")}</span></span>
      </label>
      <label className="choice-row">
        <input type="radio" name={name} checked={picked !== null} onChange={() => onChange([])} aria-labelledby={`${name}-some`} aria-describedby={`${name}-some-h`} data-testid={`${testId}-some`} />
        <span className="choice-body"><span className="choice-title" id={`${name}-some`}>{t("tokens.scopeSome")}</span><span className="hint m0" id={`${name}-some-h`}>{t("tokens.scopeSomeHint")}</span></span>
      </label>
      {picked === null ? null : drawers.length === 0 ? <p className="hint my6">{t("tokens.scopeNone")}</p> : (
        <div role="group" aria-label={t("tokens.scopePick")} className="mt8" data-testid={`${testId}-drawers`}>
          {drawers.map((d) => (
            <label className="check-row my6" key={d.id}>
              <input type="checkbox" checked={picked.includes(d.id)} aria-labelledby={`${name}-${d.id}`} onChange={(e) => onChange(e.target.checked ? [...picked, d.id] : picked.filter((id) => id !== d.id))} />
              <span id={`${name}-${d.id}`}>{d.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
