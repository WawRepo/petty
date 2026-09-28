/**
 * Where to go once signed in and unlocked (PETTY-274). Only the device login page asks for this: a
 * person who opens the link `petty auth login` printed, while signed out or locked, lands back on it
 * after signing in instead of on Home. The path holds only the request's code, never content; it is
 * kept for this tab (sessionStorage) and for as long as a request lives.
 */
const KEY = "petty.after-unlock";
const TTL_MS = 15 * 60_000;
const ALLOWED = /^\/device(\?code=[A-Za-z0-9-]{1,20})?$/;

export function rememberAfterUnlock(path: string): void {
  if (!ALLOWED.test(path)) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() })); } catch { /* storage blocked: Home it is */ }
}

/** The page to open instead of Home, if one is waiting. Reading it does not clear it (render may run twice). */
export function afterUnlock(): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { path?: unknown; at?: unknown } | null;
    if (!v || typeof v.path !== "string" || typeof v.at !== "number" || !ALLOWED.test(v.path) || Date.now() - v.at > TTL_MS) return null;
    return v.path;
  } catch {
    return null;
  }
}

/** The page it named calls this once it is open. */
export function clearAfterUnlock(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
