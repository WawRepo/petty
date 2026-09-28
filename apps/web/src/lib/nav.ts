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
    // The browser runs the update at its next frame; a page that draws none (a window in the background)
    // would never get there, so after 300 ms the navigation goes ahead without the change (PETTY-269).
    let gone = false;
    const go = () => { if (!gone) { gone = true; nav(to); } };
    doc.startViewTransition(async () => {
      go();
      for (let i = 0; i < 50 && !document.querySelector(ready); i++) await new Promise((r) => window.setTimeout(r, 16));
    });
    window.setTimeout(go, 300);
  };
}

/**
 * Back, with the change played the other way (PETTY-269): this screen's middle (which carries its
 * view-transition name always) shrinks into the bubble it grew out of on the screen behind. `target` is a
 * selector for that bubble there, by its `data-vt`; it takes the name only for this change, since a named
 * bubble would freeze mid-pop on later changes. No such bubble in view (a drawer folded into its place,
 * or another screen behind): a plain change. A plain back without the API and under reduced motion.
 */
export function useMorphBack(fallback: string): (vt: string, target: string) => void {
  const back = useBack(fallback);
  return (vt, target) => {
    const doc = document as Document & { startViewTransition?: (update: () => Promise<void>) => { finished: Promise<void> } };
    if (typeof doc.startViewTransition !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { back(); return; }
    let el: HTMLElement | null = null;
    let gone = false;
    const go = () => { if (!gone) { gone = true; back(); } };
    const change = doc.startViewTransition(async () => {
      go();
      for (let i = 0; i < 50 && !el; i++) {
        el = document.querySelector<HTMLElement>(target);
        if (!el) await new Promise((r) => window.setTimeout(r, 16));
      }
      if (el) el.style.viewTransitionName = vt;
    });
    void change.finished.finally(() => { if (el) el.style.viewTransitionName = ""; });
    window.setTimeout(go, 300); // as in useMorph: a page that draws no frame still goes back
  };
}
