import { useId, useRef, type ReactNode } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";

interface Props { open: boolean; title: string; onClose: () => void; children: ReactNode }
/** Bottom sheet from the prototype, as a real modal dialog. */
export function Sheet({ open, title, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, onClose);
  if (!open) return null;
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
