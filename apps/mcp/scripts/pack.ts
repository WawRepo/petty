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
  // PETTY-232: the add-on must identify the release it came from — the manifest may not drift from the package.
  const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")) as { version?: string };
  if (m["version"] !== pkg.version) fail(`manifest.version ${String(m["version"])} != package.json version ${pkg.version} — bump them together`);
  // PETTY-225: the archive must carry its licence and third-party notices (produced by `pnpm run notices`).
  for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) if (!statSync(join(root, f), { throwIfNoEntry: false })?.isFile()) fail(`${f} missing from ${root} — run \`pnpm run pack\`, not pack.ts directly`);
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
// The same input gives the same archive on every machine (PETTY-296, review S11). A ZIP stores
// wall-clock time, which fflate reads in the local time zone, so the fixed date is built from local
// fields; and every file gets mode 0644, whatever the builder's umask left on disk.
const mtime = new Date(2026, 0, 1, 0, 0, 0);
for (const p of files(dir).sort()) {
  const name = relative(dir, p).split(sep).join("/");
  zip[name] = [new Uint8Array(readFileSync(p)), { level: 9, mtime, os: 3, attrs: (0o100000 | 0o644) << 16 }];
}
writeFileSync(out, zipSync(zip));
process.stdout.write(`pack: ${out} (${Object.keys(zip).length} files)\n`);
