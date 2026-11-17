import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, type Io } from "./io.js";
import { KeychainError, systemKeychain, type Keychain } from "./keychain.js";

/**
 * Where `petty` keeps its logins (PETTY-274): ~/.petty/hosts.json, one entry per Petty, readable by
 * this user only (0600 in a 0700 folder), like `gh`'s hosts file. No drawer content is ever written here
 * (rule 1).
 *
 * PETTY-276: the token itself goes to the system's keychain (keychain.ts) when there is one that works;
 * the file then keeps the rest of the login and `"token_in": "keychain"`. Without a keychain, with one
 * that fails, or with PETTY_TOKEN_STORE=file, the token stays in the file, as before. A token still in
 * the file moves to the keychain the first time a command reads it.
 */
export interface HostLogin {
  /** The token, when this file keeps it. A token opens the drawers it may read. */
  readonly token?: string;
  /** "keychain" when the system's keychain keeps the token; the file then has none. */
  readonly token_in?: "keychain";
  /** The token's name, as Settings → Access tokens lists it. */
  readonly name: string;
  readonly role: "read" | "write";
  readonly user_id: string;
  readonly added_at: string;
}

export interface Store {
  /** The origin used when a command names no --host. */
  readonly default: string | null;
  readonly hosts: Readonly<Record<string, HostLogin>>;
}

const EMPTY: Store = { default: null, hosts: {} };

export const configDir = (env: Record<string, string | undefined>): string => env["PETTY_CONFIG_DIR"] || join(env["HOME"] || homedir(), ".petty");
export const storePath = (env: Record<string, string | undefined>): string => join(configDir(env), "hosts.json");

export function readStore(env: Record<string, string | undefined>): Store {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(storePath(env), "utf8"));
  } catch {
    return EMPTY;
  }
  if (typeof raw !== "object" || raw === null) return EMPTY;
  const r = raw as { default?: unknown; hosts?: unknown };
  const hosts: Record<string, HostLogin> = {};
  if (typeof r.hosts === "object" && r.hosts !== null) {
    for (const [origin, v] of Object.entries(r.hosts as Record<string, unknown>)) {
      const h = v as Partial<HostLogin>;
      if (h?.role !== "read" && h?.role !== "write") continue;
      const rest = { name: String(h.name ?? ""), role: h.role, user_id: String(h.user_id ?? ""), added_at: String(h.added_at ?? "") };
      // a token in the file is where the token is, whatever else the entry says
      if (typeof h.token === "string") hosts[origin] = { token: h.token, ...rest };
      else if (h.token_in === "keychain") hosts[origin] = { token_in: "keychain", ...rest };
    }
  }
  const def = typeof r.default === "string" && hosts[r.default] ? r.default : (Object.keys(hosts)[0] ?? null);
  return { default: def, hosts };
}

/** Written whole, to a file only this user can read, then moved into place. */
export function writeStore(env: Record<string, string | undefined>, store: Store): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = storePath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

/** A warning when other accounts on this machine can read the file (it can be copied in by hand). */
export function openToOthers(file: string): boolean {
  if (process.platform === "win32") return false;
  try {
    return (statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------- the token's place

/**
 * The keychain new tokens go to, or null when they go to the file: PETTY_TOKEN_STORE=file says so.
 * Checked before a sign-in starts, so a mistyped value never costs a token made on the page.
 */
export function newTokensKeychain(io: Io): Keychain | null {
  const mode = io.env["PETTY_TOKEN_STORE"] ?? "";
  if (mode === "file") return null;
  if (mode !== "" && mode !== "auto") throw new CliError(2, `PETTY_TOKEN_STORE takes "file" or "auto", not ${JSON.stringify(mode)}`);
  return systemKeychain(io.platform, io.env);
}

const QUIET = "PETTY_TOKEN_STORE=file keeps it there without this note";

/** The keychain has the token only when it gives the same token back; else it holds nothing of it. */
async function putChecked(kc: Keychain, origin: string, token: string): Promise<void> {
  await kc.set(origin, token);
  let back: string | null;
  try { back = await kc.get(origin); } catch (e) { await kc.remove(origin).catch(() => undefined); throw e; }
  if (back !== token) {
    await kc.remove(origin).catch(() => undefined);
    throw new KeychainError(false, "it gave back another token");
  }
}

function putEntry(env: Record<string, string | undefined>, origin: string, login: HostLogin, asDefault: boolean): void {
  const s = readStore(env);
  writeStore(env, { default: asDefault ? origin : s.default, hosts: { ...s.hosts, [origin]: login } });
}

/**
 * Keeps a new login and makes it the default: the token in the keychain when it takes it, else in the
 * file, with one note on stderr when the keychain failed. Returns where the token is, for a sentence.
 */
export async function keepLogin(io: Io, origin: string, login: HostLogin & { readonly token: string }): Promise<string> {
  const before = readStore(io.env).hosts[origin];
  const { token, ...rest } = login;
  const kc = newTokensKeychain(io);
  if (kc) {
    try {
      await putChecked(kc, origin, token);
      putEntry(io.env, origin, { ...rest, token_in: "keychain" }, true);
      return kc.name;
    } catch (e) {
      if (!(e instanceof KeychainError)) throw e;
      if (!e.absent) io.err(`petty: note: ${kc.name} did not take the token (${e.message}); it is kept in ${storePath(io.env)} instead. ${QUIET}.\n`);
    }
  }
  putEntry(io.env, origin, login, true);
  // the earlier login for this address, still in the keychain, is out of date now
  if (before?.token_in === "keychain") await systemKeychain(io.platform, io.env).remove(origin).catch(() => undefined);
  return storePath(io.env);
}

/**
 * Moves a token from the file to the keychain, the first time a command reads it. The file loses the
 * token only after the keychain gave it back, and only if no other run changed the entry meanwhile.
 * Returns the keychain's name, or null when the token stays in the file.
 */
async function moveToKeychain(io: Io, origin: string, token: string): Promise<string | null> {
  const kc = newTokensKeychain(io);
  if (!kc) return null;
  try {
    await putChecked(kc, origin, token);
  } catch (e) {
    if (!(e instanceof KeychainError)) throw e;
    if (!e.absent) io.err(`petty: note: the token for ${origin} could not move to ${kc.name} (${e.message}); it stays in ${storePath(io.env)}. ${QUIET}.\n`);
    return null;
  }
  const s = readStore(io.env);
  const now = s.hosts[origin];
  if (now?.token !== token) return null;
  const kept: HostLogin = { token_in: "keychain", name: now.name, role: now.role, user_id: now.user_id, added_at: now.added_at };
  writeStore(io.env, { ...s, hosts: { ...s.hosts, [origin]: kept } });
  io.err(`petty: the token for ${origin} moved from ${storePath(io.env)} to ${kc.name}.\n`);
  return kc.name;
}

/** A stored login's token, and where it is kept: `keychain` true, or the file. */
export interface Got { readonly token: string; readonly keychain: boolean; readonly where: string }

/**
 * The token of a stored login: from the keychain when the file says it is there. A keychain that cannot
 * give it is exit code 3 with what to do; the entry stays, so unlocking the keychain brings it back.
 * `move`: a token still in the file moves to the keychain now (not while Tab completes a word).
 */
export async function tokenOf(io: Io, origin: string, login: HostLogin, move: boolean): Promise<Got> {
  if (login.token === undefined) {
    const kc = systemKeychain(io.platform, io.env);
    let token: string | null;
    try {
      token = await kc.get(origin);
    } catch (e) {
      if (!(e instanceof KeychainError)) throw e;
      throw new CliError(3, e.absent
        ? `the token for ${origin} is in a keychain this computer cannot open (${e.message}): run petty auth login --host ${origin}`
        : `${kc.name} did not give the token for ${origin} (${e.message}). Unlock it and try again, or run petty auth login --host ${origin}`);
    }
    if (token === null) throw new CliError(3, `${kc.name} has no token for ${origin} any more: run petty auth login --host ${origin}`);
    return { token, keychain: true, where: kc.name };
  }
  const moved = move ? await moveToKeychain(io, origin, login.token) : null;
  return moved ? { token: login.token, keychain: true, where: moved } : { token: login.token, keychain: false, where: storePath(io.env) };
}

/**
 * Forgets a login here: its keychain entry, then its entry in the file. Returns what the person must
 * still do by hand when the keychain did not remove it, else null.
 */
export async function forgetLogin(io: Io, origin: string, login: HostLogin): Promise<string | null> {
  let left: string | null = null;
  if (login.token === undefined) {
    const kc = systemKeychain(io.platform, io.env);
    try {
      await kc.remove(origin);
    } catch (e) {
      if (!(e instanceof KeychainError)) throw e;
      left = `${kc.name} did not remove the token (${e.message}): delete its entry for ${origin} there by hand`;
    }
  }
  const s = readStore(io.env);
  const hosts = { ...s.hosts };
  delete hosts[origin];
  writeStore(io.env, { default: s.default === origin ? (Object.keys(hosts)[0] ?? null) : s.default, hosts });
  return left;
}
