import { useEffect, useState } from "react";

/**
 * "Add to home screen" (PETTY-36). Chrome/Android/desktop fire one
 * `beforeinstallprompt` per page load; we keep it and let the user trigger it
 * from the nudge or from Settings. Safari never fires it: iOS users get the
 * Share → Add to Home Screen instructions instead.
 */
interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }
let deferred: BIPEvent | null = null;
const listeners = new Set<() => void>();
function notify(): void { for (const l of listeners) l(); }
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as BIPEvent; notify(); });
  window.addEventListener("appinstalled", () => { deferred = null; notify(); });
}

export function isStandalone(): boolean {
  return typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
}
export function isIOS(): boolean {
  return typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** Shows the browser's install dialog. Resolves to what the user chose; the event is single-use. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = deferred;
  if (!e) return "unavailable";
  deferred = null;
  notify();
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  return choice.outcome;
}

export type InstallState = "installed" | "prompt" | "ios" | "manual";
/** What the UI can offer right now. */
export function useInstallState(): InstallState {
  const compute = (): InstallState => (isStandalone() ? "installed" : deferred ? "prompt" : isIOS() ? "ios" : "manual");
  const [state, setState] = useState<InstallState>(compute);
  useEffect(() => { const l = () => setState(compute()); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return state;
}
