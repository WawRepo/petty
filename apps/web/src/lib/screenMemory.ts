/**
 * PETTY-417 (security review #19): small things one screen hands to the next that come from decrypted
 * content: the currency used last, and the tag a drawer opens filtered by. They stay in this tab's
 * memory only. Not in localStorage, which stays on disk after sign-out. Not in the page address,
 * which the browser keeps in its history on disk. Lock and sign-out forget them.
 */

/** Before PETTY-417 the last currency was kept in localStorage under this name. */
const OLD_LAST_CURRENCY = "petty.lastCurrency";

let lastCurrency: string | null = null;
let tagFilter: { drawerId: string; key: string } | null = null;
const listeners = new Set<() => void>();

export const lastUsedCurrency = (): string | null => lastCurrency;
export function rememberCurrency(code: string): void {
  lastCurrency = code;
}

/** Opens a drawer filtered by one tag (its folded key): the drawer screen takes it once. */
export function filterNextDrawer(drawerId: string, key: string): void {
  tagFilter = { drawerId, key };
  for (const fn of [...listeners]) fn();
}

/** The tag this drawer was asked to open filtered by, once; null when none, or when it was for another drawer. */
export function takeTagFilter(drawerId: string): string | null {
  if (!tagFilter || tagFilter.drawerId !== drawerId) return null;
  const { key } = tagFilter;
  tagFilter = null;
  return key;
}

/** Called when a filter is asked for, also for the drawer already on screen. Returns the way to stop. */
export function onTagFilter(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Lock and sign-out. Also removes the copy an older version left in localStorage. */
export function forgetScreenMemory(): void {
  lastCurrency = null;
  tagFilter = null;
  dropOldCopy();
}

function dropOldCopy(): void {
  try { globalThis.localStorage?.removeItem(OLD_LAST_CURRENCY); } catch { /* storage blocked: nothing to remove */ }
}
dropOldCopy();
