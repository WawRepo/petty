import { useEffect, useRef, type RefObject } from "react";

// PETTY-279: an element taken out of the tab order (tabindex="-1") is not a place for focus, an input
// included — the vault forms carry a hidden username field for password managers.
const FOCUSABLE = ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]']
  .map((s) => `${s}:not([tabindex="-1"])`)
  .join(", ");

/** Modal behaviour (spec: Accessibility): focus moves in, stays in, Escape closes, focus returns on close. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  // The latest onClose, without re-running the trap: a new function on every render used to move focus
  // back to the first field on each keystroke (PETTY-279).
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    // a field that took focus itself (autoFocus) keeps it
    if (!root.contains(document.activeElement)) (root.querySelector<HTMLElement>(FOCUSABLE) ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) { e.preventDefault(); return; }
      const firstEl = items[0]!, lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [ref, open]);
}
