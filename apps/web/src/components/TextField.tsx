import { useId, type InputHTMLAttributes, type ReactNode } from "react";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string | undefined;
  error?: ReactNode;
}
/** Every field has a real <label>; errors are linked with aria-describedby (spec: Accessibility). */
export function TextField({ label, hint, error, id, ...rest }: Props) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={described} {...rest} />
      {hint ? <div className="hint mt6" id={hintId}>{hint}</div> : null}
      {error ? <div className="error" id={errorId} role="alert">{error}</div> : null}
    </div>
  );
}
