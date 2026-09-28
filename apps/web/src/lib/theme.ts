import { useSyncExternalStore } from "react";

/**
 * PETTY-259: the theme — the device's own ("system"), light or dark. Kept on the device, like the
 * language. A forced theme sets `data-theme` on <html>, which picks the palette in tokens.css (without
 * it, prefers-color-scheme decides), and the browser's colour-scheme and theme-color metas follow.
 */
export type Theme = "system" | "light" | "dark";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
const KEY = "petty.theme";
const BAR = { light: "#f5f3ef", dark: "#151412" } as const; // --bg of each palette, as in index.html

export function savedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

const dark = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
/** The palette on screen now: the forced one, or the device's. */
export const resolvedTheme = (t: Theme = savedTheme()): "light" | "dark" => (t === "system" ? (dark() ? "dark" : "light") : t);

/** Runs before the first render (main.tsx) and on every change. */
export function applyTheme(t: Theme = savedTheme()): void {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme; else root.dataset.theme = t;
  document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.setAttribute("content", t === "system" ? "light dark" : t);
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = m.media.includes("dark") ? BAR.dark : BAR.light;
    m.content = t === "system" ? own : BAR[t];
  }
}

const listeners = new Set<() => void>();
export function setTheme(t: Theme): void {
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* storage blocked: this visit only */ }
  applyTheme(t);
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener("change", l);
  return () => { listeners.delete(l); mq?.removeEventListener("change", l); };
}
/** The chosen theme and the palette it resolves to; re-renders on a change of either. */
export function useTheme(): { theme: Theme; resolved: "light" | "dark" } {
  const key = useSyncExternalStore(subscribe, () => `${savedTheme()}:${resolvedTheme()}`, () => "system:light");
  const [theme, resolved] = key.split(":") as [Theme, "light" | "dark"];
  return { theme, resolved };
}
