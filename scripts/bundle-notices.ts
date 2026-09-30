/**
 * Licence notices for a single-file bundle: the command line (petty.mjs) and the MCP server
 * (petty-mcp.mjs, and server/index.mjs inside petty.mcpb). PETTY-225, PETTY-292 (review S4).
 *
 * esbuild inlines the dependencies, so their licence files do not travel with the file on their own;
 * MIT and similar licences require their notice to accompany the code. This reads esbuild's metafile —
 * the exact list of files that went into the bundle — maps each to its package, and:
 * - with --bundle: puts a header after the file's #! line (what it is, its version, AGPL-3.0-only, the
 *   source of this version) and appends every bundled package's licence text as a closing comment, so
 *   a file that is downloaded on its own still carries everything;
 * - with --md: also writes those notices as a Markdown file (it ships inside petty.mcpb).
 *
 *   tsx scripts/bundle-notices.ts --meta meta.json --what "petty, the Petty command line" \
 *     [--bundle dist/petty.mjs] [--md out.md]
 *
 * The source address is VITE_SOURCE_URL when set (a fork's own, as for the web app) or the root
 * package.json's repository; the version comes from the package.json in the working directory.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({ options: { meta: { type: "string" }, what: { type: "string" }, bundle: { type: "string" }, md: { type: "string" } } });
if (!opt.meta || !opt.what || (!opt.bundle && !opt.md)) throw new Error("usage: bundle-notices.ts --meta <meta.json> --what <text> [--bundle <file>] [--md <out.md>]");

interface Pkg { name: string; version: string; license: string; text: string | null }

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

const meta = JSON.parse(readFileSync(opt.meta, "utf8")) as { inputs: Record<string, unknown> };
const pkgs = new Map<string, Pkg>();
for (const input of Object.keys(meta.inputs)) {
  const root = packageRoot(input);
  if (!root) continue;
  const abs = resolve(dirname(opt.meta), root);
  const pj = join(abs, "package.json");
  if (!existsSync(pj)) continue;
  const p = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string; license?: string | { type?: string } };
  if (!p.name || p.name.startsWith("@petty/")) continue;
  const key = `${p.name}@${p.version ?? "?"}`;
  if (pkgs.has(key)) continue;
  const license = typeof p.license === "string" ? p.license : (p.license?.type ?? "UNKNOWN");
  pkgs.set(key, { name: p.name, version: p.version ?? "?", license, text: licenseText(abs) });
}
const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const missing = list.filter((p) => !p.text);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { repository?: { url?: string } };
const source = (process.env["VITE_SOURCE_URL"]?.trim() || (rootPkg.repository?.url ?? "")).replace(/^git\+/, "").replace(/\.git$/, "");
const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
// The tree at this version's tag on GitHub; on another host, whose paths differ, the repository itself.
const sourceHere = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(source) ? `${source.replace(/\/$/, "")}/tree/v${version}` : source;

const intro = (into: string) => [
  `The third-party packages below are bundled into ${into}, each with its licence text as shipped in`,
  "that package. Petty itself is licensed under the GNU Affero General Public License v3.0 only",
  `(AGPL-3.0-only); the source of this version is at ${sourceHere}. Generated at build time.`,
];

if (opt.md) {
  const lines: string[] = [
    `# Third-party notices — ${opt.what}`, "", ...intro(`${opt.what} (${opt.bundle ? opt.bundle.split("/").pop() : "its bundle"})`), "",
    "| Package | Version | Licence |", "|---|---|---|",
    ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`), "",
  ];
  for (const p of list) {
    lines.push("---", "", `## ${p.name} ${p.version} — ${p.license}`, "");
    lines.push(p.text ?? `(No licence file is shipped in this package; its package.json declares \`${p.license}\`.)`, "");
  }
  writeFileSync(opt.md, lines.join("\n"));
}

if (opt.bundle) {
  const code = readFileSync(opt.bundle, "utf8");
  const shebang = code.startsWith("#!") ? code.slice(0, code.indexOf("\n") + 1) : "";
  const header = [
    "/*!",
    ` * ${opt.what} — version ${version}. Copyright (C) 2026 Petty contributors.`,
    " * Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only),",
    " * https://www.gnu.org/licenses/agpl-3.0.html",
    ` * Source code of this version: ${sourceHere}`,
    " * The third-party packages bundled into this file, with their licences, are listed at its end.",
    " */",
    "",
  ].join("\n");
  // A licence text must not close the comment it sits in.
  const safe = (t: string) => t.replace(/\*\//g, "*\\/");
  const trailer = [
    "",
    "/*! Third-party notices",
    "",
    ...intro("this file"),
    "",
    ...list.flatMap((p) => ["-----", "", `${p.name} ${p.version} — ${p.license}`, "", safe(p.text ?? `(No licence file is shipped in this package; its package.json declares ${p.license}.)`), ""]),
    "*/",
    "",
  ].join("\n");
  writeFileSync(opt.bundle, shebang + header + code.slice(shebang.length) + trailer);
}

process.stdout.write(`notices: ${[opt.bundle, opt.md].filter(Boolean).join(" and ")} — ${list.length} packages${missing.length ? `, ${missing.length} without a licence file: ${missing.map((p) => p.name).join(", ")}` : ""}\n`);
