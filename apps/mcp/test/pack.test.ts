import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * PETTY-296 (review S11): the add-on archive is the same bytes for the same input on every machine.
 * Before, the builder's time zone changed the stored times and its umask the stored modes, so three
 * builds of one release gave three different petty.mcpb files.
 */
const root = mkdtempSync(join(tmpdir(), "petty-pack-"));
const folder = join(root, "mcpb");
mkdirSync(join(folder, "server"), { recursive: true });
writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
writeFileSync(join(folder, "manifest.json"), JSON.stringify({
  manifest_version: "0.2", name: "petty", version: "9.9.9", description: "test", author: { name: "t" },
  server: { type: "node", entry_point: "server/index.mjs", mcp_config: { command: "node", args: ["${__dirname}/server/index.mjs"] } },
}));
writeFileSync(join(folder, "server", "index.mjs"), "console.log('petty');\n");
writeFileSync(join(folder, "LICENSE"), "licence\n");
writeFileSync(join(folder, "THIRD_PARTY_NOTICES.md"), "# notices\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function pack(tz: string, mode: number): string {
  chmodSync(join(folder, "server", "index.mjs"), mode);
  const out = join(root, `out-${tz.replace("/", "-")}-${mode.toString(8)}.mcpb`);
  execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../scripts/pack.ts"), folder, out], { env: { ...process.env, TZ: tz } });
  return createHash("sha256").update(readFileSync(out)).digest("hex");
}

describe("pack.ts", () => {
  it("gives the same archive whatever the time zone and the file modes", () => {
    const a = pack("UTC", 0o644);
    expect(pack("Pacific/Auckland", 0o664)).toBe(a);
    expect(pack("America/Los_Angeles", 0o600)).toBe(a);
  });
});
