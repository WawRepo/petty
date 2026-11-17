import { spawn } from "node:child_process";
import { win32 } from "node:path";

/**
 * The login token in the system's own keychain (PETTY-276), through the system's own tools, so that a
 * copy of the home folder (a backup, a synced folder, another program reading files) has no token in it.
 * The token never goes on a command line, where `ps` or the task list shows it to every user:
 *
 * - **macOS**: the login keychain, through `security`. `security -i` reads its command from stdin, so the
 *   line with the token goes there. Reading prints the token to our stdout.
 * - **Linux and other systems**: the Secret Service (GNOME Keyring, KWallet), through `secret-tool`,
 *   which reads the token to store from stdin.
 * - **Windows**: Credential Manager, through Windows PowerShell 5.1 (on every Windows since 10) calling
 *   CredWriteW, CredReadW and CredDeleteW of advapi32. The script is the -EncodedCommand argument and
 *   holds no secret; what to do, the entry's name and the token go on stdin. The script also runs on
 *   pwsh 7. PowerShell is started from the Windows folder by its full path: Windows looks for a bare
 *   program name in the current folder first.
 *
 * An entry is named by service "petty" and the Petty's address (on Windows the target "petty:<address>").
 */
export interface Keychain {
  /** As a sentence says it: "Kept in the macOS keychain." */
  readonly name: string;
  /** The token, or null when the keychain has none for this address. */
  get(origin: string): Promise<string | null>;
  set(origin: string, token: string): Promise<void>;
  /** Removes the entry; no entry is not an error. */
  remove(origin: string): Promise<void>;
}

/**
 * The keychain could not do it. `absent`: there is no keychain tool on this computer (no `secret-tool`),
 * which is a choice of the computer, not a fault, and petty then keeps the token in the file quietly.
 */
export class KeychainError extends Error {
  constructor(readonly absent: boolean, message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

const SERVICE = "petty";
/** A locked keychain may ask for its password in a window: time to type it, but never a hang. */
const TIMEOUT_MS = 15_000;
/**
 * Printable ASCII without space, quotes or backslash. A token (`petty_pat_<id>.<base64>`) and an address
 * (URL.origin, with the host in punycode) are always in it; anything else is refused, so no quoting
 * rule of `security -i` or a line break on stdin can change what the tool is asked to do. The characters
 * are listed one by one, not as wide ranges across letters and signs, so a reader (and CodeQL, alert #98)
 * sees each one.
 */
export const PLAIN = /^[A-Za-z0-9!#$%&()*+,\-./:;<=>?@[\]^_`{|}~]+$/;

function plain(what: string, value: string): string {
  if (!PLAIN.test(value)) throw new KeychainError(false, `the ${what} has characters the keychain is not given`);
  return value;
}

interface Ran { readonly code: number | null; readonly out: string; readonly err: string }

/** Runs a tool with `input` on stdin; its first line of stderr explains a failure. */
function runTool(cmd: string, args: readonly string[], input: string, env: Record<string, string | undefined>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (f: () => void) => { if (!done) { done = true; clearTimeout(timer); f(); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(new KeychainError(false, (e as Error).message));
      return;
    }
    const timer = setTimeout(() => finish(() => { child.kill(); reject(new KeychainError(false, `${cmd} did not answer in ${TIMEOUT_MS / 1000} s`)); }), TIMEOUT_MS);
    timer.unref();
    let out = "", err = "";
    child.stdout!.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr!.on("data", (b: Buffer) => { err += b.toString("utf8"); });
    child.on("error", (e: NodeJS.ErrnoException) => finish(() => reject(e.code === "ENOENT" ? new KeychainError(true, `${cmd} not found`) : new KeychainError(false, e.message))));
    child.on("close", (code) => finish(() => resolve({ code, out, err })));
    child.stdin!.on("error", () => undefined); // a tool that exits without reading stdin
    child.stdin!.end(input);
  });
}

/** The tool's own words for a failure, one line, without the token (it never prints it on stderr). */
function why(ran: Ran, tool: string): string {
  const line = ran.err.split("\n").map((l) => l.trim()).find(Boolean);
  return line ? line.replace(/^[\w.-]+: /, "") : `${tool} ended with ${ran.code}`;
}

// ---------------------------------------------------------------------------------------------- macOS

function macKeychain(env: Record<string, string | undefined>): Keychain {
  const run = (args: readonly string[], input = "") => runTool("security", args, input, env);
  const NOT_FOUND = 44; // errSecItemNotFound, as `security` exits
  return {
    name: "the macOS keychain",
    async get(origin) {
      const ran = await run(["find-generic-password", "-s", SERVICE, "-a", plain("address", origin), "-w"]);
      if (ran.code === NOT_FOUND) return null;
      if (ran.code !== 0) throw new KeychainError(false, why(ran, "security"));
      return ran.out.replace(/\n$/, "") || null;
    },
    async set(origin, token) {
      // -U replaces an earlier entry for this address; the whole line, token included, goes on stdin
      const line = `add-generic-password -U -s "${SERVICE}" -a "${plain("address", origin)}" -l "Petty login (${origin})" -w "${plain("token", token)}"\n`;
      const ran = await run(["-i"], line);
      if (ran.code !== 0) throw new KeychainError(false, why(ran, "security"));
    },
    async remove(origin) {
      const ran = await run(["delete-generic-password", "-s", SERVICE, "-a", plain("address", origin)]);
      if (ran.code !== 0 && ran.code !== NOT_FOUND) throw new KeychainError(false, why(ran, "security"));
    },
  };
}

// ---------------------------------------------------------------------------------------------- Linux

function secretService(env: Record<string, string | undefined>): Keychain {
  const run = (args: readonly string[], input = "") => runTool("secret-tool", args, input, env);
  const attrs = (origin: string) => ["service", SERVICE, "account", plain("address", origin)];
  return {
    name: "the keyring (Secret Service)",
    async get(origin) {
      const ran = await run(["lookup", ...attrs(origin)]);
      // nothing found: exit 1 and nothing on stderr; a failure says why on stderr
      if (ran.code !== 0) { if (!ran.err.trim()) return null; throw new KeychainError(false, why(ran, "secret-tool")); }
      return ran.out.replace(/\n$/, "") || null;
    },
    async set(origin, token) {
      const ran = await run(["store", "--label", `Petty login (${origin})`, ...attrs(origin)], plain("token", token));
      if (ran.code !== 0) throw new KeychainError(false, why(ran, "secret-tool"));
    },
    async remove(origin) {
      const ran = await run(["clear", ...attrs(origin)]);
      if (ran.code !== 0 && ran.err.trim()) throw new KeychainError(false, why(ran, "secret-tool"));
    },
  };
}

// -------------------------------------------------------------------------------------------- Windows

/**
 * C# 5 (what Windows PowerShell 5.1 compiles), no newer syntax. The token's bytes are zeroed before
 * their buffer is freed. Persist 2 = CRED_PERSIST_LOCAL_MACHINE: this computer's user, not roamed.
 * No progress records: Windows PowerShell can write them to a redirected stderr, before the error.
 */
const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $in = [Console]::In.ReadToEnd().Split([char]10)
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class PettyCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public int LastWrittenLow; public int LastWrittenHigh;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);
  private const int GENERIC = 1, NOT_FOUND = 1168;
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, GENERIC, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == NOT_FOUND) return null;
      throw new Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Encoding.UTF8.GetString(b);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string secret) {
    byte[] b = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = GENERIC; c.Persist = 2; c.TargetName = target; c.UserName = "petty"; c.Comment = "Petty command line login";
    c.CredentialBlobSize = b.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWriteW(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.Copy(new byte[b.Length], 0, c.CredentialBlob, b.Length);
      Marshal.FreeHGlobal(c.CredentialBlob);
    }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, GENERIC, 0)) {
      int e = Marshal.GetLastWin32Error();
      if (e != NOT_FOUND) throw new Win32Exception(e);
    }
  }
}
'@
  $op = $in[0].Trim(); $target = $in[1].Trim()
  if ($op -eq 'get') { $s = [PettyCredential]::Read($target); if ($null -eq $s) { exit 2 }; [Console]::Out.Write($s); exit 0 }
  if ($op -eq 'set') { [PettyCredential]::Write($target, $in[2].Trim()); exit 0 }
  if ($op -eq 'delete') { [PettyCredential]::Delete($target); exit 0 }
  [Console]::Error.WriteLine('petty: no such step'); exit 1
} catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  [Console]::Error.WriteLine('petty: ' + $e.Message); exit 1
}
`;

/** The arguments PowerShell is started with: the script, encoded as PowerShell takes it (UTF-16LE, base64). */
export const windowsArgs = (): string[] => ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")];

/** `powershell` is the full path of powershell.exe; tests give another program. */
export function windowsKeychain(powershell: string, env: Record<string, string | undefined>): Keychain {
  const run = (op: string, origin: string, token = "") => runTool(powershell, windowsArgs(), `${op}\n${SERVICE}:${plain("address", origin)}\n${token}\n`, env);
  return {
    name: "Windows Credential Manager",
    async get(origin) {
      const ran = await run("get", origin);
      if (ran.code === 2) return null;
      if (ran.code !== 0) throw new KeychainError(false, why(ran, "PowerShell"));
      return ran.out || null;
    },
    async set(origin, token) {
      const ran = await run("set", origin, plain("token", token));
      if (ran.code !== 0) throw new KeychainError(false, why(ran, "PowerShell"));
    },
    async remove(origin) {
      const ran = await run("delete", origin);
      if (ran.code !== 0) throw new KeychainError(false, why(ran, "PowerShell"));
    },
  };
}

/** This computer's keychain, by the system petty runs on. */
export function systemKeychain(platform: NodeJS.Platform, env: Record<string, string | undefined>): Keychain {
  if (platform === "darwin") return macKeychain(env);
  if (platform === "win32") return windowsKeychain(win32.join(env["SystemRoot"] || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), env);
  return secretService(env);
}
