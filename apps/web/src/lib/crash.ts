/**
 * What the crash screen shows and logs (PETTY-60, PETTY-461): the error's class and, when it has one,
 * its stable code. Never its message: a message can quote what the person wrote (CLAUDE.md rule 2).
 */
const SAFE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function crashLabel(error: unknown): string {
  const name = error instanceof Error && SAFE.test(error.name) ? error.name : "Error";
  const raw = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const code = typeof raw === "string" && SAFE.test(raw) ? raw : "";
  return code && code !== name ? `${name} (${code})` : name;
}
