import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Stand-ins for the keychain tools (PETTY-276), put first on the PATH: `security` (macOS), `secret-tool`
 * (Linux) and `powershell` (Windows), each answering as the real one does, from one JSON file. Each run
 * logs its arguments, so a test can check that no token ever went on a command line. `mode` makes the
 * keychain fail ("broken": as a locked keychain or a session without D-Bus) or take a token and keep
 * nothing ("lossy").
 */
const SHIM = String.raw`#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = __dirname, tool = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify([tool, ...args]) + "\n");
const mode = fs.existsSync(path.join(dir, "mode")) ? fs.readFileSync(path.join(dir, "mode"), "utf8").trim() : "ok";
const file = path.join(dir, "store.json");
const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(store));
let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}
const fail = (msg, code) => { process.stderr.write(msg + "\n"); process.exit(code); };
const keep = (key, value) => { if (mode !== "lossy") { store[key] = value; save(); } process.exit(0); };
if (mode === "broken") {
  if (tool === "security") fail("security: SecKeychainSearchCopyNext: User interaction is not allowed.", 36);
  if (tool === "secret-tool") fail("secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY", 1);
  fail("petty: The credential is locked.", 1);
}
const opt = (name) => args[args.indexOf(name) + 1];
if (tool === "security") {
  if (args[0] === "-i") {
    const m = /^add-generic-password -U -s "([^"]*)" -a "([^"]*)" -l "[^"]*" -w "([^"]*)"\n$/.exec(input);
    if (!m) fail("security: unknown command", 1);
    keep(m[1] + " " + m[2], m[3]);
  }
  const key = opt("-s") + " " + opt("-a");
  const missing = () => fail("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.", 44);
  if (args[0] === "find-generic-password") { if (!(key in store)) missing(); process.stdout.write(store[key] + "\n"); process.exit(0); }
  if (args[0] === "delete-generic-password") { if (!(key in store)) missing(); delete store[key]; save(); process.exit(0); }
} else if (tool === "secret-tool") {
  const attrs = args.slice(args[0] === "store" ? 3 : 1);
  const key = attrs[1] + " " + attrs[3];
  if (args[0] === "store") keep(key, input);
  if (args[0] === "lookup") { if (!(key in store)) process.exit(1); process.stdout.write(store[key]); process.exit(0); }
  if (args[0] === "clear") { delete store[key]; save(); process.exit(0); }
} else if (tool === "powershell") {
  if (!args.includes("-EncodedCommand")) fail("petty: no script", 1);
  const [op, target, token] = input.split("\n");
  const key = target.replace(/^petty:/, "petty ");
  if (op === "get") { if (!(key in store)) process.exit(2); process.stdout.write(store[key]); process.exit(0); }
  if (op === "set") keep(key, token);
  if (op === "delete") { delete store[key]; save(); process.exit(0); }
}
fail(tool + ": unexpected " + args.join(" "), 1);
`;

export interface FakeKeychain {
  readonly dir: string;
  /** PATH with the stand-ins first, then this process's PATH (they run on node). */
  readonly path: string;
  /** What the keychain holds: "petty <address>" → token. */
  store(): Record<string, string>;
  /** Every run's program and arguments. */
  argv(): string[][];
  mode(m: "ok" | "broken" | "lossy"): void;
  clear(): void;
  remove(): void;
}

export function fakeKeychain(): FakeKeychain {
  const dir = mkdtempSync(join(tmpdir(), "petty-keychain-"));
  for (const tool of ["security", "secret-tool", "powershell"]) {
    writeFileSync(join(dir, tool), SHIM);
    chmodSync(join(dir, tool), 0o755);
  }
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return {
    dir,
    path: `${dir}${delimiter}${process.env["PATH"] ?? ""}`,
    store: () => JSON.parse(read("store.json") || "{}") as Record<string, string>,
    argv: () => read("argv.log").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]),
    mode: (m) => writeFileSync(join(dir, "mode"), m),
    clear: () => { for (const f of ["store.json", "argv.log", "mode"]) rmSync(join(dir, f), { force: true }); },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
