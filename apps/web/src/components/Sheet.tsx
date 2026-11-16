import { useEffect, useId, useRef, type ReactNode } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";

/**
 * PETTY-493: the sheet's buttons stay at its bottom while its body scrolls (PETTY-125), on top of the body.
 * The browser brings a field that gets focus into view only as far as the sheet's edge, which is under
 * those buttons; this scrolls the field up until it is clear of them.
 */
function clearOfButtons(sheet: HTMLElement, el: Element): void {
  const bar = sheet.querySelector(":scope > form > .actions:last-child, :scope > .actions:last-child");
  if (el === sheet || !bar || bar.contains(el) || !sheet.contains(el)) return;
  const under = el.getBoundingClientRect().bottom - bar.getBoundingClientRect().top;
  if (under > 0) sheet.scrollBy({ top: under + 12, behavior: "instant" });
}

interface Props { open: boolean; title: string; onClose: () => void; children: ReactNode }
/** Bottom sheet from the prototype, as a real modal dialog. */
export function Sheet({ open, title, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // before the focus trap's effect, so that the first field it focuses is cleared too
  useEffect(() => {
    const sheet = ref.current;
    if (!open || !sheet) return;
    // in the next frame: after the browser's own scroll for the focus
    const onFocusIn = (e: FocusEvent) => { const el = e.target; if (el instanceof Element) requestAnimationFrame(() => clearOfButtons(sheet, el)); };
    sheet.addEventListener("focusin", onFocusIn);
    return () => sheet.removeEventListener("focusin", onFocusIn);
  }, [open]);
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
