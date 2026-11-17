import { createContext, useContext, useSyncExternalStore } from "react";

/** From this width, Home's list stays on the left and the drawer or item opens beside it (PETTY-138). */
export const WIDE = "(min-width: 900px)";

/** Whether the window is wide enough for the two panes, following resizes. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const q = window.matchMedia(WIDE);
      q.addEventListener("change", changed);
      return () => q.removeEventListener("change", changed);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

/**
 * What a screen needs to know when it is drawn in one of the two panes. `null` (no provider) is the
 * one-column app, where nothing changes.
 *  - `side`: "list" for Home on the left, "detail" for the drawer or item on the right.
 *  - `drawer`, `line`: what the right pane shows (from the address), for the list's selected row.
 *  - `overview`: on "/" the right pane's slot for Home's total and picture; `null` while a drawer is open.
 *  - `toList`: closes the right pane and puts focus back on the drawer's row.
 */
export interface Pane {
  side: "list" | "detail";
  drawer: string | null;
  line: string | null;
  overview: HTMLElement | null;
  toList: () => void;
}

export const PaneContext = createContext<Pane | null>(null);
export const usePane = (): Pane | null => useContext(PaneContext);
