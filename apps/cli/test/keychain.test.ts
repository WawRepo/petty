import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KeychainError, systemKeychain, windowsArgs, windowsKeychain, type Keychain } from "../src/keychain.js";
import { fakeKeychain } from "./fake-keychain.js";

/**
 * The three keychain backends (PETTY-276) against stand-ins of their tools (fake-keychain.ts). What the
 * stand-ins cannot show: that the real `security`, `secret-tool` and Credential Manager behave as they
 * do. `security -i` and its quoting were tried by hand on macOS; the PowerShell script is run by pwsh
 * below where pwsh is installed, up to the call into advapi32, which only Windows has.
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

describe.each(backends)("the keychain on %s (PETTY-276)", (_name, make) => {
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
