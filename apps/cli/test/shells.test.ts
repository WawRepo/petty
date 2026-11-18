import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { script } from "../src/complete.js";

/**
 * The Tab completion scripts in the real shells (PETTY-274): each parses, and where the shell can be
 * driven without a terminal (bash, PowerShell), one real Tab round runs through `petty __complete`.
 * A shell that is not installed here is skipped. CI's Ubuntu has bash and pwsh; CI's Windows job
 * (PETTY-510) runs the PowerShell rounds only, in pwsh 7 and in Windows PowerShell 5.1.
 */
const windows = process.platform === "win32";
const dir = mkdtempSync(join(tmpdir(), "petty-shells-"));
const root = resolve(import.meta.dirname, "..");

/**
 * How `petty` is made a command, as docs/cli.md says: a script on PATH on macOS and Linux; on Windows a
 * PowerShell function, or a petty.cmd on PATH, as the docs said before PETTY-510 (cmd.exe reads its command
 * line, so a Tab press must not put a word there).
 */
type Shim = "script" | "function" | "cmd";

/** Makes `petty` run node with `args`, then its own words. Returns the PowerShell line that does it, if any. */
function petty(shim: Shim, folder: string, ...args: string[]): string {
  const words = [process.execPath, ...args];
  if (shim === "function") return `function petty { & ${words.map((w) => `'${w.replace(/'/g, "''")}'`).join(" ")} @args }\n`;
  if (shim === "cmd") {
    writeFileSync(join(folder, "petty.cmd"), `@${words.map((w) => `"${w}"`).join(" ")} %*\r\n`);
  } else {
    writeFileSync(join(folder, "petty"), `#!/bin/sh\nexec ${words.map((w) => `"${w}"`).join(" ")} "$@"\n`);
    chmodSync(join(folder, "petty"), 0o755);
  }
  return "";
}

/** This process's variables, `folder` first on PATH (Windows spells it Path: one spelling only), and `more`. */
function envWith(folder: string, more: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== "PATH") env[k] = v;
  return { ...env, PATH: `${folder}${delimiter}${process.env["PATH"] ?? ""}`, ...more };
}

// `petty`: this checkout's CLI, run from source; on Windows the function the docs tell PowerShell users to make
const realPetty = petty(windows ? "function" : "script", dir, join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/bin.ts"));
const env = envWith(dir, { PETTY_CONFIG_DIR: dir, PETTY_TOKEN: "", PETTY_TOKEN_STORE: "file" });
const has = (cmd: string) => (windows ? spawnSync("where.exe", [cmd]) : spawnSync("sh", ["-c", `command -v ${cmd}`])).status === 0;
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { env, encoding: "utf8", timeout: 60_000 });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Tab completion in real shells (PETTY-274)", () => {
  for (const bash of ["/bin/bash", "bash"]) {
    it.skipIf(windows || !has(bash))(`${bash}: the script parses, and Tab offers the commands`, () => {
      writeFileSync(join(dir, "petty.bash"), script("bash"));
      expect(sh(bash, ["-n", join(dir, "petty.bash")]).status).toBe(0);
      const round = (words: string, cword: number) =>
        sh(bash, ["-c", `eval "$(petty completion -s bash)"; COMP_WORDS=(${words}); COMP_CWORD=${cword}; _petty_complete; printf '%s\\n' "\${COMPREPLY[@]}"`]).stdout.trim().split("\n");
      expect(round("petty au", 1)).toEqual(["auth"]);
      expect(round(`petty auth ""`, 2)).toEqual(["login", "status", "logout", "token"]);
      expect(round(`petty auth login --expires ""`, 4)).toEqual(["30", "90", "365", "never"]);
    });
  }

  for (const bash of ["/bin/bash", "bash"]) {
    it.skipIf(windows || !has(bash))(`${bash}: a name with * ? [ or spaces is one candidate, as it is, never matched against files (PETTY-519)`, () => {
      // A stand-in `petty` offers these names, in a folder whose files each pattern would match.
      const fake = resolve(mkdtempSync(join(tmpdir(), "petty-bash-")));
      try {
        const names = ["a*", "b?c", "[x]", "Kitchen tin › *", "back\\slash", "plain"];
        for (const f of ["abc", "a1", "bxc", "x", "Kitchen tin › box"]) writeFileSync(join(fake, f), "");
        writeFileSync(join(fake, "names"), `${names.join("\n")}\n\n`);
        writeFileSync(join(fake, "petty.bash"), script("bash"));
        writeFileSync(join(fake, "petty"), `#!/bin/sh\n[ "$1" = "__complete" ] && cat "$PETTY_NAMES"\n`);
        chmodSync(join(fake, "petty"), 0o755);
        const r = spawnSync(bash, ["-c", `cd "$PETTY_DIR" && . ./petty.bash && COMP_WORDS=(petty untag ""); COMP_CWORD=2; _petty_complete; printf '%s\\n' "\${#COMPREPLY[@]}" "\${COMPREPLY[@]}"`], {
          env: { ...process.env, PATH: `${fake}:${process.env["PATH"]}`, PETTY_NAMES: join(fake, "names"), PETTY_DIR: fake },
          encoding: "utf8", timeout: 60_000,
        });
        expect(r.stderr).toBe("");
        // the count first: the empty line at the end is no candidate
        expect(r.stdout.trimEnd().split("\n")).toEqual([String(names.length), ...names]);
      } finally {
        rmSync(fake, { recursive: true, force: true });
      }
    });
  }

  it.skipIf(windows || !has("zsh"))("zsh: the script parses, and its function hands compadd the commands", () => {
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

  it.skipIf(windows || !has("fish"))("fish: the script parses", () => {
    writeFileSync(join(dir, "petty.fish"), script("fish"));
    expect(sh("fish", ["--no-execute", join(dir, "petty.fish")]).status).toBe(0);
  });

  it("PowerShell quotes every candidate but a plain word, with its own rule for the quote characters (PETTY-415)", () => {
    const ps = script("powershell");
    expect(ps).toContain("$text = if ($name -cmatch '\\A[A-Za-z0-9_-]+\\z') { $name } else { \"'\" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($name) + \"'\" }");
    // PETTY-510: no word goes on petty's command line, and each name comes back in base64
    expect(ps).toContain("petty __complete 2>$null | ForEach-Object {");
    expect(ps).toContain("$env:PETTY_COMPLETE_WORDS = ConvertTo-Json -InputObject @($prior) -Compress");
    // the script is plain ASCII: PowerShell on Windows may read a pipe in another code page
    expect(/^[\n\x20-\x7e]*$/.test(ps)).toBe(true);
  });
});

/**
 * Each PowerShell here: pwsh 7, and on Windows also Windows PowerShell 5.1 (powershell.exe), which every
 * Windows has (PETTY-510). Progress records are off: Windows PowerShell writes them to a redirected stderr.
 */
const POWERSHELLS = windows ? ["pwsh", "powershell"] : ["pwsh"];
const powershell = (ps: string, command: string, env: NodeJS.ProcessEnv) =>
  spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `$ProgressPreference = 'SilentlyContinue'\n${command}`], { env, encoding: "utf8", timeout: 60_000 });

describe.each(POWERSHELLS)("Tab completion in %s (PETTY-274)", (ps) => {
  // PETTY-503: one PowerShell for the three Tab rounds. Three of them, each loading the script through
  // `petty completion`, took most of the 30 s budget on a busy CI runner and once ran past it.
  it.skipIf(!has(ps))("the script loads, and Tab offers the commands", () => {
    const lines = ["petty au", "petty auth ", "petty completion -s p"];
    const r = powershell(ps, `${realPetty}petty completion -s powershell | Out-String | Invoke-Expression; ${lines.map((l) => `(TabExpansion2 -inputScript '${l}' -cursorColumn ${l.length}).CompletionMatches | ForEach-Object CompletionText; '--'`).join("; ")}`, env);
    expect(r.stderr).toBe("");
    // each round's candidates, then a "--" line
    const rounds: string[][] = [[]];
    for (const l of r.stdout.split(/\r?\n/)) if (l === "--") rounds.push([]); else if (l) rounds.at(-1)!.push(l);
    expect(rounds).toEqual([["auth"], ["login", "status", "logout", "token"], ["powershell"], []]);
  }, 90_000);

  // through a petty.cmd too: a Tab press puts no word on its command line (PETTY-510)
  it.skipIf(!has(ps)).each(windows ? ["function", "cmd"] as const : ["script"] as const)("after a quoted word, petty gets that word's value, not its quotes (PETTY-493), `petty` a %s", (shim) => {
    // A stand-in `petty` writes down how many arguments it got, the words it is asked to complete after,
    // and the word being typed.
    const fake = mkdtempSync(join(tmpdir(), "petty-pwsh-"));
    try {
      const lines = ["petty untag 'Kitchen tin \u203a Cash' ", "petty untag 'a''b' ga", 'petty untag "Shed `"box" ', "petty untag \u2018x\u2019\u2019y\u2019 ", "petty untag Kitchen ", "petty untag 'Kit"];
      writeFileSync(join(fake, "lines"), `${lines.join("\n")}\n`);
      // not petty.ps1: PowerShell would take that file for the command `petty`, and use no native completer
      writeFileSync(join(fake, "complete.ps1"), script("powershell"));
      writeFileSync(join(fake, "fake.cjs"), `const fs = require("fs"), a = process.argv.slice(2);
if (a[0] === "__complete") fs.appendFileSync(process.env.PETTY_ARGS, [a.length, ...JSON.parse(process.env.PETTY_COMPLETE_WORDS), process.env.PETTY_COMPLETE_CURRENT].map((w) => w + "|").join("") + "\\n");
`);
      const define = petty(shim, fake, join(fake, "fake.cjs"));
      const r = powershell(ps, `${define}
        Get-Content -Raw -LiteralPath $env:PETTY_SCRIPT | Invoke-Expression
        foreach ($line in (Get-Content -Encoding utf8 -LiteralPath $env:PETTY_LINES)) { $null = TabExpansion2 -inputScript $line -cursorColumn $line.Length }`,
      envWith(fake, { PETTY_SCRIPT: join(fake, "complete.ps1"), PETTY_LINES: join(fake, "lines"), PETTY_ARGS: join(fake, "args") }));
      expect(r.stderr).toBe("");
      expect(readFileSync(join(fake, "args"), "utf8").trimEnd().split("\n")).toEqual([
        "1|untag|Kitchen tin \u203a Cash|=|",
        "1|untag|a'b|=ga|",
        '1|untag|Shed "box|=|',
        "1|untag|x\u2019y|=|",
        "1|untag|Kitchen|=|",
        // the word being typed comes as PowerShell has it; petty reads its quotes (unquotePowerShell)
        "1|untag|='Kit'|",
      ]);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(!has(ps))("a name from a drawer goes in as one quoted argument, and the finished line runs nothing else (PETTY-415, PETTY-510)", () => {
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
      writeFileSync(join(fake, "complete.ps1"), script("powershell"));
      // names go out as petty sends them to PowerShell: base64 of their UTF-8, one a line
      writeFileSync(join(fake, "fake.cjs"), `const fs = require("fs"), a = process.argv.slice(2);
if (a[0] === "__complete") for (const n of fs.readFileSync(process.env.PETTY_NAMES, "utf8").split("\\n").filter(Boolean)) process.stdout.write(Buffer.from(n).toString("base64") + "\\n");
else for (const w of a) fs.appendFileSync(process.env.PETTY_ARGS, w + "\\n");
`);
      // on Windows the function the docs tell PowerShell users to make: through a petty.cmd, cmd.exe would read
      // the finished line, and run what follows the & or | in a name
      const define = petty(windows ? "function" : "script", fake, join(fake, "fake.cjs"));
      // the candidates are kept, each finished line is run, and only then printed, in UTF-8: what the Tab
      // got is read in PowerShell's own code page, as a person's PowerShell reads it
      const r = powershell(ps, `${define}
        Get-Content -Raw -LiteralPath $env:PETTY_SCRIPT | Invoke-Expression
        $texts = @((TabExpansion2 -inputScript 'petty add ' -cursorColumn 10).CompletionMatches | ForEach-Object CompletionText)
        foreach ($t in $texts) { Invoke-Expression ('petty add ' + $t) }
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
        foreach ($t in $texts) { [Console]::Out.WriteLine($t) }`,
      envWith(fake, { PETTY_NAMES: join(fake, "names"), PETTY_SCRIPT: join(fake, "complete.ps1"), PETTY_ARGS: join(fake, "args"), PETTY_MARK: join(fake, "mark") }));
      expect(r.stderr).toBe("");
      // PowerShell reads \u2018 \u2019 \u201a \u201b as a quote too: all are doubled
      const quoted = (n: string) => (/^[A-Za-z0-9_-]+$/.test(n) ? n : `'${n.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`);
      expect(r.stdout.trim().split(/\r?\n/)).toEqual(names.map(quoted));
      expect(existsSync(join(fake, "mark"))).toBe(false);
      expect(readFileSync(join(fake, "args"), "utf8").trimEnd().split("\n")).toEqual(names.flatMap((n) => ["add", n]));
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  }, 90_000);
});
