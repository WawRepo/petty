/**
 * Third-party notices for the bundled MCP server (PETTY-225, public-readiness review R5).
 *
 * esbuild bundles dependencies INTO mcpb/server/index.mjs, so their licence files do not travel with
 * it on their own. MIT and similar licences require the copyright + permission notice to accompany
 * the code, so this reads esbuild's metafile — the exact list of files that went into the bundle —
 * maps each to its package, and writes every bundled package's licence text into one notices file
 * that ships inside the .mcpb and next to the standalone script.
 *
 *   tsx scripts/notices.ts <meta.json> <out.md>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [metaPath = "meta.json", out = "mcpb/THIRD_PARTY_NOTICES.md"] = process.argv.slice(2);

interface Pkg { name: string; version: string; license: string; text: string | null; root: string }

/** The package root of a bundled file: the directory right after the LAST `node_modules/` (two for @scope/name). */
function packageRoot(file: string): string | null {
  const parts = file.split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) return null; // a workspace source file, not a third-party package
  const scoped = parts[i + 1]?.startsWith("@");
  const end = i + (scoped ? 3 : 2);
  if (parts.length < end) return null;
  return parts.slice(0, end).join("/");
}

function licenseText(root: string): string | null {
  const names = readdirSync(root).filter((n) => /^(licen[cs]e|copying)(\..*)?$/i.test(n));
  if (names.length === 0) return null;
  return readFileSync(join(root, names.sort()[0]!), "utf8").trim();
}

const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { inputs: Record<string, unknown> };
const pkgs = new Map<string, Pkg>();
for (const input of Object.keys(meta.inputs)) {
  const root = packageRoot(input);
  if (!root) continue;
  const abs = resolve(dirname(metaPath), root);
  const pj = join(abs, "package.json");
  if (!existsSync(pj)) continue;
  const p = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string; license?: string | { type?: string } };
  if (!p.name || p.name.startsWith("@petty/")) continue;
  const key = `${p.name}@${p.version ?? "?"}`;
  if (pkgs.has(key)) continue;
  const license = typeof p.license === "string" ? p.license : (p.license?.type ?? "UNKNOWN");
  pkgs.set(key, { name: p.name, version: p.version ?? "?", license, text: licenseText(abs), root });
}

const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
const missing = list.filter((p) => !p.text);
const lines: string[] = [
  "# Third-party notices — Petty MCP server",
  "",
  "This file lists every third-party package bundled into `server/index.mjs` (and the standalone",
  "`petty-mcp.mjs`), with each package's licence text as shipped in that package. Petty itself is",
  "licensed under the GNU AGPL v3 (see LICENSE); its source is at https://github.com/WawRepo/petty.",
  "Generated at build time from the bundler's file list — do not edit by hand.",
  "",
  "| Package | Version | Licence |",
  "|---|---|---|",
  ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  "",
];
for (const p of list) {
  lines.push("---", "", `## ${p.name} ${p.version} — ${p.license}`, "");
  lines.push(p.text ?? `(No licence file is shipped in this package; its package.json declares \`${p.license}\`.)`, "");
}
writeFileSync(out, lines.join("\n"));
process.stdout.write(`notices: ${out} — ${list.length} packages${missing.length ? `, ${missing.length} without a licence file: ${missing.map((p) => p.name).join(", ")}` : ""}\n`);
