import { useNavigate } from "react-router";

/**
 * The top-bar back button. Goes BACK in history when there is somewhere to go
 * back to, so Settings → Admin → back → back lands on Home instead of pushing
 * Settings again and looping (PETTY-36). On a deep link (nothing behind us in
 * this tab) it replaces the entry with the screen's natural parent.
 * React Router keeps its position in `history.state.idx`.
 */
export function useBack(fallback: string): () => void {
  const nav = useNavigate();
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(fallback, { replace: true });
  };
}

/**
 * Navigation with the landing page's kind of change (PETTY-250): the tapped bubble of a picture grows
 * into the next screen's picture. The two elements share a view-transition name; `ready` is a selector
 * for the one on the next screen only (not the tapped bubble, which carries the same name). The screens
 * load lazily, so the swap waits (at most ~0.8 s) for it to render before the browser captures the new page. A plain navigation where the browser has no View
 * Transitions and under reduced motion.
 */
export function useMorph(): (to: string, ready: string) => void {
  const nav = useNavigate();
  return (to, ready) => {
    const doc = document as Document & { startViewTransition?: (update: () => Promise<void>) => unknown };
    if (typeof doc.startViewTransition !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { nav(to); return; }
    doc.startViewTransition(async () => {
      nav(to);
      for (let i = 0; i < 50 && !document.querySelector(ready); i++) await new Promise((r) => window.setTimeout(r, 16));
    });
  };
}
