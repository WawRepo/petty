import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { win32 } from "node:path";

/**
 * Everything `petty` does to the outside world, in one place, so tests can drive the whole program in
 * memory. Results go to stdout (and only results: scripts and agents read it); messages, prompts and the
 * sign-in code go to stderr.
 */
export interface Io {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly env: Record<string, string | undefined>;
  readonly fetch: typeof fetch;
  /** All of stdin, for --with-token and --note - */
  readonly stdin: () => Promise<string>;
  /** One line typed at the terminal; null without a terminal. */
  readonly ask: (question: string) => Promise<string | null>;
  readonly interactive: boolean;
  /** Tries to open a page in the browser. False when there is no way to. */
  readonly openUrl: (url: string) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly hostname: string;
}

/** A failure with the exit code it ends the program with: 1 error, 2 usage, 3 login, 4 not found. */
export class CliError extends Error {
  constructor(readonly exitCode: 1 | 2 | 3 | 4, message: string) {
    super(message);
    this.name = "CliError";
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The program and its arguments that open a page, or null when there is nothing to run (PETTY-453).
 * Only an http: or https: address is opened, in the form the URL parser gives it. No shell reads the
 * address on any system: on Windows it goes to rundll32 of the Windows folder, never through `cmd`.
 */
export function browserCommand(url: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): { cmd: string; args: string[] } | null {
  let page: URL;
  try { page = new URL(url); } catch { return null; }
  if (page.protocol !== "http:" && page.protocol !== "https:") return null;
  if (platform === "darwin") return { cmd: "open", args: [page.href] };
  if (platform === "win32") return { cmd: win32.join(env["SystemRoot"] || "C:\\Windows", "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", page.href] };
  // no display on Linux (a server over SSH): printing the address is all we can do
  if (platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return null;
  return { cmd: "xdg-open", args: [page.href] };
}

/** Opens a page without waiting for the browser and without its output. */
function openInBrowser(url: string, env: Record<string, string | undefined>): boolean {
  const run = browserCommand(url, process.platform, env);
  if (!run) return false;
  try {
    const child = spawn(run.cmd, run.args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function realIo(): Io {
  const interactive = !!process.stdin.isTTY && !!process.stderr.isTTY;
  return {
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s); },
    env: process.env,
    fetch: globalThis.fetch,
    stdin: () => readAll(process.stdin),
    ask: async (question) => {
      if (!interactive) return null;
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return (await rl.question(question)).trim(); } finally { rl.close(); }
    },
    interactive,
    openUrl: (url) => openInBrowser(url, process.env),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    hostname: hostname(),
  };
}
