/**
 * Third-party notices for the web app (PETTY-225, public-readiness review R5 / F6).
 *
 * The production bundle inlines its dependencies and the minifier drops their licence headers, so a
 * visitor receives MIT-licensed code without the notice those licences require to travel with it.
 * This writes every shipped production dependency's licence text into public/THIRD_PARTY_NOTICES.md,
 * which the app serves at /THIRD_PARTY_NOTICES.md and links from the landing page. It runs as part of
 * `pnpm build`. Over-inclusive by design: it lists the web workspace's whole production dependency
 * tree, a superset of what tree-shaking keeps — a notice too many is harmless, one too few is not.
 *
 *   tsx scripts/notices.ts [out.md]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2] ?? "public/THIRD_PARTY_NOTICES.md";
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface Entry { name: string; versions: string[]; paths: string[]; license: string }
interface Pkg { name: string; version: string; license: string; text: string | null }

function licenseText(root: string): string | null {
  let names: string[];
  try { names = readdirSync(root).filter((n) => /^(licen[cs]e|copying)(\..*)?$/i.test(n)); } catch { return null; }
  if (names.length === 0) return null;
  return readFileSync(join(root, names.sort()[0]!), "utf8").trim();
}

const raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod", "--filter", "@petty/web"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const byLicense = JSON.parse(raw) as Record<string, Entry[]>;
const seen = new Set<string>();
const pkgs: Pkg[] = [];
for (const list of Object.values(byLicense)) {
  for (const e of list) {
    if (e.name.startsWith("@petty/")) continue;
    e.versions.forEach((version, i) => {
      const key = `${e.name}@${version}`;
      if (seen.has(key)) return;
      seen.add(key);
      const dir = e.paths[i] ?? e.paths[0];
      pkgs.push({ name: e.name, version, license: e.license, text: dir ? licenseText(dir) : null });
    });
  }
}
pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const lines: string[] = [
  "# Third-party notices — Petty web app",
  "",
  "This file lists the third-party packages shipped in this web application's production bundle, with",
  "each package's licence text as it appears in that package. Petty itself is licensed under the GNU",
  "AGPL v3; its source code is linked from the page you came from. Generated at build time from the",
  "production dependency list — do not edit by hand.",
  "",
  "| Package | Version | Licence |",
  "|---|---|---|",
  ...pkgs.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  "",
];
for (const p of pkgs) {
  lines.push("---", "", `## ${p.name} ${p.version} — ${p.license}`, "");
  lines.push(p.text ?? `(No licence file is shipped in this package; its package.json declares \`${p.license}\`.)`, "");
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n"));
const missing = pkgs.filter((p) => !p.text).length;
process.stdout.write(`notices: ${out} — ${pkgs.length} packages${missing ? `, ${missing} without a licence file` : ""}\n`);
