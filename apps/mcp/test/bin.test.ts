import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `--print-config` (the easy install): prints a settings block with this machine's real paths. */
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

describe("petty-mcp --print-config", () => {
  it("prints the MCP block with absolute node + file paths and a placeholder token", () => {
    const out = execFileSync(process.execPath, [tsx, bin, "--print-config", "https://petty.example.com/api/"], { encoding: "utf8" });
    const cfg = JSON.parse(out) as { mcpServers: { petty: { command: string; args: string[]; env: Record<string, string> } } };
    const p = cfg.mcpServers.petty;
    expect(p.command).toBe(process.execPath);
    expect(p.args).toEqual([bin]);
    expect(p.env).toEqual({ PETTY_TOKEN: "petty_pat_…", PETTY_API_URL: "https://petty.example.com/api" });
  });

  it("refuses without an address, without touching the token", () => {
    const r = spawnSync(process.execPath, [tsx, bin, "--print-config"], { encoding: "utf8", env: { ...process.env, PETTY_API_URL: "", PETTY_TOKEN: "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(r.stdout).toBe("");
  });
});
