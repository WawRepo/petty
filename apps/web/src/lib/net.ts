import { useSyncExternalStore } from "react";

/** Online/offline as the app experiences it: browser events plus the outcome of real requests. */
let online = typeof navigator === "undefined" ? true : navigator.onLine;
const listeners = new Set<() => void>();
const onlineListeners = new Set<() => void>();
function emit(): void { for (const l of listeners) l(); }
export function markOnline(): void { if (!online) { online = true; emit(); for (const l of onlineListeners) l(); } }
export function markOffline(): void { if (online) { online = false; emit(); } }
export function isOnline(): boolean { return online; }
export function useOnline(): boolean { return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => online); }
/** Called once when connectivity comes back (browser event or a request that succeeded after failures). */
export function onBackOnline(fn: () => void): () => void { onlineListeners.add(fn); return () => onlineListeners.delete(fn); }
if (typeof window !== "undefined") {
  window.addEventListener("online", markOnline);
  window.addEventListener("offline", markOffline);
}
