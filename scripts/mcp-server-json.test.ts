import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * PETTY-311: scripts/mcp-server-json.ts writes an entry the MCP Registry takes. The rules checked here
 * are the registry's own (v1.8.1): its schema's name pattern and 100-character title and description,
 * and its MCPB checks (an https address on github.com that contains "mcp", a fileSha256, no
 * registryBaseUrl). The GitHub login allows names under io.github.<owner>/, compared case for case.
 */
const script = join(import.meta.dirname, "mcp-server-json.ts");
const dir = mkdtempSync(join(tmpdir(), "petty-mcpreg-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const mcpb = join(dir, "petty.mcpb");
writeFileSync(mcpb, "not really a zip, only bytes to hash\n");
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("mcp-server-json", () => {
  it("writes an entry the registry accepts, pointing at the release's add-on", () => {
    const res = run("v1.5.9", mcpb);
    assert.equal(res.status, 0, res.stderr);
    const e = JSON.parse(res.stdout);
    assert.match(e.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    assert.ok(e.name.startsWith("io.github.WawRepo/"), "the GitHub login proves io.github.WawRepo/*, case for case");
    assert.equal(e.version, "1.5.9");
    assert.ok(e.title.length <= 100 && e.description.length > 0 && e.description.length <= 100, `description has ${e.description.length} characters`);
    assert.deepEqual(e.repository, { url: "https://github.com/WawRepo/petty", source: "github", subfolder: "apps/mcp" });
    assert.equal(e.packages.length, 1);
    const [p] = e.packages;
    assert.equal(p.registryType, "mcpb");
    assert.equal(p.identifier, "https://github.com/WawRepo/petty/releases/download/v1.5.9/petty.mcpb");
    assert.equal(new URL(p.identifier).host, "github.com");
    assert.ok(p.identifier.toLowerCase().includes("mcp"));
    assert.equal(p.registryBaseUrl, undefined);
    assert.deepEqual(p.transport, { type: "stdio" });
    assert.equal(p.fileSha256, createHash("sha256").update("not really a zip, only bytes to hash\n").digest("hex"));
  });

  it("refuses a tag that is not vX.Y.Z, and a missing file", () => {
    assert.equal(run("1.5.9", mcpb).status, 1);
    assert.equal(run("v1.5", mcpb).status, 1);
    assert.equal(run("v1.5.9").status, 1);
    assert.notEqual(run("v1.5.9", join(dir, "missing.mcpb")).status, 0);
  });
});
