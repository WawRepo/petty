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
