import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { script } from "../src/complete.js";

/**
 * The Tab completion scripts in the real shells (PETTY-274): each parses, and where the shell can be
 * driven without a terminal (bash, PowerShell), one real Tab round runs through `petty __complete`.
 * A shell that is not installed here is skipped; CI's Ubuntu has bash and zsh.
 */
const dir = mkdtempSync(join(tmpdir(), "petty-shells-"));
const root = resolve(import.meta.dirname, "..");
// `petty` on PATH: this checkout's CLI, run from source
writeFileSync(join(dir, "petty"), `#!/bin/sh\nexec "${join(root, "node_modules/.bin/tsx")}" "${join(root, "src/bin.ts")}" "$@"\n`);
chmodSync(join(dir, "petty"), 0o755);
const env = { ...process.env, PATH: `${dir}:${process.env["PATH"]}`, PETTY_CONFIG_DIR: dir, PETTY_TOKEN: "" };
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { env, encoding: "utf8", timeout: 60_000 });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Tab completion in real shells (PETTY-274)", () => {
  for (const bash of ["/bin/bash", "bash"]) {
    it.skipIf(!has(bash))(`${bash}: the script parses, and Tab offers the commands`, () => {
      writeFileSync(join(dir, "petty.bash"), script("bash"));
      expect(sh(bash, ["-n", join(dir, "petty.bash")]).status).toBe(0);
      const round = (words: string, cword: number) =>
        sh(bash, ["-c", `eval "$(petty completion -s bash)"; COMP_WORDS=(${words}); COMP_CWORD=${cword}; _petty_complete; printf '%s\\n' "\${COMPREPLY[@]}"`]).stdout.trim().split("\n");
      expect(round("petty au", 1)).toEqual(["auth"]);
      expect(round(`petty auth ""`, 2)).toEqual(["login", "status", "logout", "token"]);
      expect(round(`petty auth login --expires ""`, 4)).toEqual(["30", "90", "365", "never"]);
    });
  }

  it.skipIf(!has("zsh"))("zsh: the script parses, and its function hands compadd the commands", () => {
    writeFileSync(join(dir, "_petty"), script("zsh"));
    const r = sh("zsh", ["-n", join(dir, "_petty")]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    // compadd and compdef exist only inside zsh's completion system; stand-ins show what the script passes them
    const round = (words: string, current: number) =>
      sh("zsh", ["-f", "-c", `compdef() { :; }; compadd() { shift; print -rl -- "$@"; }; eval "$(petty completion -s zsh)"; words=(${words}); CURRENT=${current}; _petty`]).stdout.trim().split("\n");
    expect(round("petty au", 2)).toEqual(["auth"]);
    expect(round(`petty auth ""`, 3)).toEqual(["login", "status", "logout", "token"]);
  });

  it.skipIf(!has("fish"))("fish: the script parses", () => {
    writeFileSync(join(dir, "petty.fish"), script("fish"));
    expect(sh("fish", ["--no-execute", join(dir, "petty.fish")]).status).toBe(0);
  });

  it.skipIf(!has("pwsh"))("PowerShell: the script loads, and Tab offers the commands", () => {
    const tab = (line: string) =>
      sh("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
        `petty completion -s powershell | Out-String | Invoke-Expression; (TabExpansion2 -inputScript '${line}' -cursorColumn ${line.length}).CompletionMatches | ForEach-Object CompletionText`]).stdout.trim().split(/\r?\n/);
    expect(tab("petty au")).toEqual(["auth"]);
    expect(tab("petty auth ")).toEqual(["login", "status", "logout", "token"]);
    expect(tab("petty completion -s p")).toEqual(["powershell"]);
  });

  it("PowerShell quotes every candidate but a plain word, with its own rule for the quote characters (PETTY-415)", () => {
    const ps = script("powershell");
    expect(ps).toContain("$text = if ($_ -cmatch '\\A[A-Za-z0-9_-]+\\z') { $_ } else { \"'\" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($_) + \"'\" }");
    // the script is plain ASCII: PowerShell on Windows may read a pipe in another code page
    expect(/^[\n\x20-\x7e]*$/.test(ps)).toBe(true);
  });

  it.skipIf(!has("pwsh") || process.platform === "win32")("PowerShell: a name from a drawer goes in as one quoted argument, and the finished line runs nothing else (PETTY-415)", () => {
    // A stand-in `petty`: asked for candidates it offers these names; run, it writes down the arguments it got.
    // Each name holds a command that would leave a file behind if PowerShell ran it.
    const mark = "New-Item($env:PETTY_MARK)";
    const names = [
      `Tin;${mark}`, "a'b", `a';${mark};'`, `$(${mark})`, "back`tick", `\`$(${mark})`, `x\u2019;${mark};\u2019`, `@(${mark})`, `{${mark}}`,
      `a|${mark}`, `a&${mark}`, "#x", "Kitchen \u203a Cash", "K\u00fcche", "Kitchen",
      // a name with a new line cannot be one candidate: its lines arrive apart, and each is quoted by itself
      "new", `line;${mark}`,
    ];
    const fake = mkdtempSync(join(tmpdir(), "petty-pwsh-"));
    try {
      writeFileSync(join(fake, "names"), `${names.join("\n")}\n`);
      writeFileSync(join(fake, "petty.ps1"), script("powershell"));
      writeFileSync(join(fake, "petty"), `#!/bin/sh\nif [ "$1" = "__complete" ]; then cat "$PETTY_NAMES"; else for a in "$@"; do printf '%s\\n' "$a" >> "$PETTY_ARGS"; done; fi\n`);
      chmodSync(join(fake, "petty"), 0o755);
      const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
        Get-Content -Raw -LiteralPath $env:PETTY_SCRIPT | Invoke-Expression
        foreach ($c in (TabExpansion2 -inputScript 'petty add ' -cursorColumn 10).CompletionMatches) {
          [Console]::Out.WriteLine($c.CompletionText)
          Invoke-Expression ('petty add ' + $c.CompletionText)
        }`], {
        env: { ...process.env, PATH: `${fake}:${process.env["PATH"]}`, PETTY_NAMES: join(fake, "names"), PETTY_SCRIPT: join(fake, "petty.ps1"), PETTY_ARGS: join(fake, "args"), PETTY_MARK: join(fake, "mark") },
        encoding: "utf8", timeout: 60_000,
      });
      expect(r.stderr).toBe("");
      // PowerShell reads \u2018 \u2019 \u201a \u201b as a quote too: all are doubled
      const quoted = (n: string) => (/^[A-Za-z0-9_-]+$/.test(n) ? n : `'${n.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`);
      expect(r.stdout.trim().split(/\r?\n/)).toEqual(names.map(quoted));
      expect(existsSync(join(fake, "mark"))).toBe(false);
      expect(readFileSync(join(fake, "args"), "utf8").trimEnd().split("\n")).toEqual(names.flatMap((n) => ["add", n]));
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });
});
