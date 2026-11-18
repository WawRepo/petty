import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KeychainError, PLAIN, systemKeychain, windowsArgs, windowsKeychain, type Keychain } from "../src/keychain.js";
import { fakeKeychain } from "./fake-keychain.js";

/**
 * The three keychain backends (PETTY-276) against stand-ins of their tools (fake-keychain.ts). What the
 * stand-ins cannot show: that the real `security`, `secret-tool` and Credential Manager behave as they
 * do. `security -i` and its quoting were tried by hand on macOS; the PowerShell script is run by pwsh
 * below where pwsh is installed, up to the call into advapi32, which only Windows has. CI runs the real
 * Credential Manager and the real Secret Service too (PETTY-510, at the end). The stand-ins are scripts
 * that Windows cannot start by name, so Windows runs only the real one.
 */
const fake = fakeKeychain();
const empty = mkdtempSync(join(tmpdir(), "petty-nopath-"));
afterAll(() => { fake.remove(); rmSync(empty, { recursive: true, force: true }); });

const ORIGIN = "https://petty.example:8443";
// made at run time, as every test token is (.gitleaks.toml); with the base64 characters + / = in it
const TOKEN = `petty_pat_AbC_123.${Buffer.from("not a real token, a stand-in").toString("base64")}+/x=`;
const env = { PATH: fake.path };
const backends: [string, () => Keychain][] = [
  ["macOS (security)", () => systemKeychain("darwin", env)],
  ["Linux (secret-tool)", () => systemKeychain("linux", env)],
  ["Windows (PowerShell)", () => windowsKeychain(join(fake.dir, "powershell"), env)],
];

describe.skipIf(process.platform === "win32").each(backends)("the keychain on %s (PETTY-276)", (_name, make) => {
  it("keeps, gives back and removes a token, and never puts it on a command line", async () => {
    fake.clear();
    const kc = make();
    expect(await kc.get(ORIGIN)).toBeNull();
    await kc.set(ORIGIN, TOKEN);
    expect(fake.store()).toEqual({ [`petty ${ORIGIN}`]: TOKEN });
    expect(await kc.get(ORIGIN)).toBe(TOKEN);
    await kc.set(ORIGIN, `${TOKEN}2`); // a new login replaces the entry
    expect(await kc.get(ORIGIN)).toBe(`${TOKEN}2`);
    await kc.remove(ORIGIN);
    expect(await kc.get(ORIGIN)).toBeNull();
    await kc.remove(ORIGIN); // nothing there is not an error
    expect(fake.argv().length).toBeGreaterThan(5);
    for (const argv of fake.argv()) expect(argv.join(" ")).not.toContain("petty_pat_");
  });

  it("says why when the keychain fails, without the token", async () => {
    fake.clear();
    fake.mode("broken");
    const kc = make();
    for (const step of [() => kc.get(ORIGIN), () => kc.set(ORIGIN, TOKEN), () => kc.remove(ORIGIN)]) {
      const e = await step().then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(KeychainError);
      expect((e as KeychainError).absent).toBe(false);
      expect((e as Error).message).not.toMatch(/^(security|secret-tool): /);
      expect((e as Error).message).not.toContain("petty_pat_");
    }
  });

  it("refuses a token or an address that could change what the tool is asked", async () => {
    fake.clear();
    const kc = make();
    for (const bad of [`${TOKEN}" -l "x`, `${TOKEN}\nset`, "petty pat"]) await expect(kc.set(ORIGIN, bad)).rejects.toThrow("characters the keychain is not given");
    await expect(kc.get("https://a\nb")).rejects.toThrow(KeychainError);
    expect(fake.argv()).toEqual([]);
  });
});

describe("no keychain tool on this computer (PETTY-276)", () => {
  it("is `absent`, so the file is used without a note", async () => {
    for (const kc of [systemKeychain("darwin", { PATH: empty }), systemKeychain("linux", { PATH: empty }), windowsKeychain(join(empty, "powershell.exe"), {})]) {
      const e = await kc.get(ORIGIN).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(KeychainError);
      expect((e as KeychainError).absent).toBe(true);
    }
  });
});

const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe("the PowerShell script (PETTY-276)", () => {
  it("starts powershell.exe from the Windows folder, never by a bare name", async () => {
    const kc = systemKeychain("win32", { SystemRoot: "D:\\Win" });
    expect(kc.name).toBe("Windows Credential Manager");
    await expect(kc.get(ORIGIN)).rejects.toThrow("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe not found");
    expect(windowsArgs().slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  });

  // pwsh outside Windows compiles the script's C# and runs it up to the call into advapi32, which is not
  // there: the stack shows that each step reached its own Credential Manager call with what came on stdin
  it.skipIf(!hasPwsh || process.platform === "win32")("parses, compiles, reads its step from stdin and reaches CredReadW, CredWriteW and CredDeleteW", () => {
    const script = Buffer.from(windowsArgs().at(-1)!, "base64").toString("utf16le");
    expect(script).not.toContain("petty_pat_");
    const traced = script.replace("[Console]::Error.WriteLine('petty: ' + $e.Message); exit 1", "[Console]::Error.WriteLine($_.Exception.ToString()); exit 1");
    expect(traced).not.toBe(script);
    const encoded = Buffer.from(traced, "utf16le").toString("base64");
    for (const [step, call] of [["get", "CredReadW"], ["set", "CredWriteW"], ["delete", "CredDeleteW"]] as const) {
      const r = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { input: `${step}\npetty:${ORIGIN}\n${TOKEN}\n`, encoding: "utf8", timeout: 60_000 });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain(`PettyCredential.${call}`);
      expect(r.stderr).not.toContain("petty_pat_");
    }
  }, 120_000);
});

describe("the characters a keychain is given (PETTY-276, code scanning #98)", () => {
  it("are printable ASCII without space, the two quotes and the backslash", () => {
    const refused = new Set([" ", '"', "'", "\\"]);
    for (let c = 0; c < 0x10000; c++) {
      const s = String.fromCharCode(c);
      expect([c, PLAIN.test(s)]).toEqual([c, c >= 0x20 && c <= 0x7e && !refused.has(s)]);
    }
  });
});

/**
 * PETTY-510: the real keychain, where CI asks for it (PETTY_REAL_KEYCHAIN=1, ci.yml): Credential Manager on
 * Windows, through Windows PowerShell 5.1 as petty starts it and through pwsh 7, and the Secret Service
 * (GNOME Keyring) on Linux. A throw-away entry is written, read three times and removed. Each step's wall
 * time is printed: Tab completion waits at most 1.5 s for names, and every read starts the tool anew.
 */
const REAL = process.env["PETTY_REAL_KEYCHAIN"] === "1";
const THROWAWAY = "https://ci.invalid";
const ms = (since: number) => `${Math.round(performance.now() - since)} ms`;

async function realRound(label: string, kc: Keychain): Promise<void> {
  let t = performance.now();
  await kc.remove(THROWAWAY);
  expect(await kc.get(THROWAWAY)).toBeNull();
  const none = ms(t);
  t = performance.now();
  await kc.set(THROWAWAY, TOKEN);
  const set = ms(t);
  const gets: string[] = [];
  for (let i = 0; i < 3; i++) {
    t = performance.now();
    expect(await kc.get(THROWAWAY)).toBe(TOKEN);
    gets.push(ms(t));
  }
  t = performance.now();
  await kc.remove(THROWAWAY);
  const removed = ms(t);
  expect(await kc.get(THROWAWAY)).toBeNull();
  console.warn(`PETTY-510 ${label}: remove + get of nothing ${none}; set ${set}; get ${gets.join(", ")}; remove ${removed}`);
}

describe.runIf(REAL && process.platform === "win32")("the real Windows Credential Manager (PETTY-510)", () => {
  it("Windows PowerShell 5.1, as petty starts it, keeps, gives back and removes an entry", async () => {
    await realRound("Credential Manager, powershell.exe", systemKeychain("win32", process.env));
  }, 120_000);

  const pwsh = REAL && process.platform === "win32" ? spawnSync("where.exe", ["pwsh"], { encoding: "utf8" }).stdout?.split(/\r?\n/)[0]?.trim() : undefined;
  it.skipIf(!pwsh)("pwsh 7 runs the same script", async () => {
    await realRound("Credential Manager, pwsh", windowsKeychain(pwsh!, process.env));
  }, 120_000);
});

describe.runIf(REAL && process.platform === "linux")("the real Secret Service (PETTY-510)", () => {
  it("secret-tool keeps, gives back and removes an entry, and a missing one is no error", async () => {
    await realRound("Secret Service, secret-tool", systemKeychain("linux", process.env));
  }, 120_000);
});
