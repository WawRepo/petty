import { useId, type ReactNode } from "react";

interface Props { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; testId?: string; className?: string }
/**
 * A titled switch (PETTY-127, audit F20): a real toggle look, and an accessible name that is the
 * title only — the hint is the description, not part of the name. The whole row is the click target.
 */
export function SwitchRow({ label, hint, checked, onChange, testId, className = "" }: Props) {
  const id = useId();
  return (
    <label className={`switch-row ${className}`.trim()}>
      <span>
        <span className="switch-label" id={`${id}-l`}>{label}</span>
        {hint ? <span className="hint m0" id={`${id}-h`}>{hint}</span> : null}
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined} data-testid={testId} />
    </label>
  );
}
