/**
 * Packs the Claude Desktop add-on (PETTY-172) without fetching anything (PETTY-186, review NR-6).
 * A .mcpb file is a ZIP with manifest.json at the root. This checks the manifest fields Petty relies
 * on, then zips the mcpb/ folder with fflate, which is pinned in the lockfile like every other tool.
 *
 *   tsx scripts/pack.ts <mcpb folder> <out.mcpb>
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync, type Zippable } from "fflate";

const [dir = "mcpb", out = "petty.mcpb"] = process.argv.slice(2);

function fail(msg: string): never {
  process.stderr.write(`pack: ${msg}\n`);
  process.exit(1);
}

/** The manifest checks: the fields Claude Desktop needs to start the server, and nothing we do not ship. */
export function checkManifest(root: string): void {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
  for (const k of ["manifest_version", "name", "version", "description", "author", "server"]) if (m[k] === undefined) fail(`manifest.${k} missing`);
  if (!/^\d+\.\d+\.\d+$/.test(String(m["version"]))) fail("manifest.version is not x.y.z");
  const server = m["server"] as { type?: string; entry_point?: string; mcp_config?: { command?: string; args?: unknown[] } };
  if (server.type !== "node") fail("server.type must be node");
  if (!server.entry_point || !statSync(join(root, server.entry_point), { throwIfNoEntry: false })?.isFile()) fail("server.entry_point is not a file in the folder");
  if (!server.mcp_config?.command || !Array.isArray(server.mcp_config.args)) fail("server.mcp_config needs command and args");
}

function files(root: string, at = root): string[] {
  return readdirSync(at).flatMap((name) => {
    if (name.startsWith(".")) return [];
    const p = join(at, name);
    return statSync(p).isDirectory() ? files(root, p) : [p];
  });
}

checkManifest(dir);
const zip: Zippable = {};
// A fixed time keeps the archive the same for the same input.
const mtime = new Date("2026-01-01T00:00:00Z");
for (const p of files(dir).sort()) {
  const name = relative(dir, p).split(sep).join("/");
  const mode = statSync(p).mode & 0o777;
  zip[name] = [new Uint8Array(readFileSync(p)), { level: 9, mtime, os: 3, attrs: (0o100000 | mode) << 16 }];
}
writeFileSync(out, zipSync(zip));
process.stdout.write(`pack: ${out} (${Object.keys(zip).length} files)\n`);
