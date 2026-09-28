import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where `petty` keeps its logins (PETTY-274): ~/.petty/hosts.json, one entry per Petty, readable by
 * this user only (0600 in a 0700 folder), like `gh`'s hosts file. A token opens the drawers it may
 * read, so nothing else may read the file. No drawer content is ever written here (rule 1).
 */
export interface HostLogin {
  readonly token: string;
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
      if (typeof h?.token === "string" && (h.role === "read" || h.role === "write")) {
        hosts[origin] = { token: h.token, name: String(h.name ?? ""), role: h.role, user_id: String(h.user_id ?? ""), added_at: String(h.added_at ?? "") };
      }
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

export function saveLogin(env: Record<string, string | undefined>, origin: string, login: HostLogin): void {
  const s = readStore(env);
  writeStore(env, { default: origin, hosts: { ...s.hosts, [origin]: login } });
}

export function forgetLogin(env: Record<string, string | undefined>, origin: string): void {
  const s = readStore(env);
  const hosts = { ...s.hosts };
  delete hosts[origin];
  writeStore(env, { default: s.default === origin ? (Object.keys(hosts)[0] ?? null) : s.default, hosts });
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
