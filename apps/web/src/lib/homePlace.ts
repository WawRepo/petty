/**
 * The place picked on Home (a path of folded place names), kept while the app runs, so that Back from a
 * drawer — or a corner bubble of its picture — lands on the level it was opened from (PETTY-269). It
 * lives in memory only: place names are content, so never in the URL, history or storage (rule 1).
 * Cleared with the drawers when the vault locks or the person signs out (resetDrawers).
 */
let picked: readonly string[] = [];

export const homePlace = (): readonly string[] => picked;
export function setHomePlace(path: readonly string[]): void { picked = [...path]; }
export function resetHomePlace(): void { picked = []; }
