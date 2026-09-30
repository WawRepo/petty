/**
 * Third-party notices for the web app (PETTY-225, public-readiness review R5 / F6).
 *
 * The production bundle inlines its dependencies and the minifier drops their licence headers, so a
 * visitor receives MIT-licensed code without the notice those licences require to travel with it.
 * This writes every shipped production dependency's licence text into public/THIRD_PARTY_NOTICES.md,
 * which the app serves at /THIRD_PARTY_NOTICES.md and links from the landing page and Settings. It runs
 * as part of `pnpm build`. Over-inclusive by design: it lists the whole production dependency tree of
 * the web app AND of the workspace packages it bundles (`@petty/web...`: hash-wasm comes in through
 * @petty/crypto), plus the Workbox runtime that the build writes into the service worker — a superset
 * of what tree-shaking keeps; a notice too many is harmless, one too few is not (PETTY-292).
 * An LGPL package (rpc-websockets, in Clerk's chunk) also needs the LGPL and GPL texts themselves
 * (LGPL-3.0 section 4): they are appended from scripts/licenses/, as published by the FSF.
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
interface Pkg { name: string; version: string; license: string; text: string | null; repo: string | null }

function licenseText(root: string): string | null {
  let names: string[];
  try { names = readdirSync(root).filter((n) => /^(licen[cs]e|copying)(\..*)?$/i.test(n)); } catch { return null; }
  if (names.length === 0) return null;
  return readFileSync(join(root, names.sort()[0]!), "utf8").trim();
}

const licenses = (args: string[]) => JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json", ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as Record<string, Entry[]>;
const seen = new Set<string>();
const pkgs: Pkg[] = [];
function add(byLicense: Record<string, Entry[]>, keep: (name: string) => boolean) {
  for (const list of Object.values(byLicense)) {
    for (const e of list) {
      if (e.name.startsWith("@petty/") || !keep(e.name)) continue;
      e.versions.forEach((version, i) => {
        const key = `${e.name}@${version}`;
        if (seen.has(key)) return;
        seen.add(key);
        const dir = e.paths[i] ?? e.paths[0];
        pkgs.push({ name: e.name, version, license: e.license, text: dir ? licenseText(dir) : null, repo: dir ? repository(dir) : null });
      });
    }
  }
}
add(licenses(["--prod", "--filter", "@petty/web..."]), () => true);
// The service worker's runtime: a build-time dependency of the PWA plugin, but its code ships in sw.js.
add(licenses(["--filter", "@petty/web"]), (name) => name.startsWith("workbox-") && name !== "workbox-build");
pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const lgpl = pkgs.filter((p) => /LGPL/i.test(p.license));

/** The package's source repository, from its package.json: the LGPL asks for a way to the library's source. */
function repository(root: string): string | null {
  try {
    const r = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { repository?: string | { url?: string } }).repository;
    const url = typeof r === "string" ? r : r?.url;
    return url ? url.replace(/^git\+/, "").replace(/\.git$/, "") : null;
  } catch { return null; }
}

const lines: string[] = [
  "# Third-party notices — Petty web app",
  "",
  "This file lists the third-party packages that the web application may ship: every production",
  "dependency of the app and of the workspace packages it bundles, and the Workbox runtime in its",
  "service worker. It is a superset of what the bundle keeps. Each package's licence text follows as it",
  "appears in that package. Petty itself is licensed under the GNU AGPL v3; its source code is linked",
  "from the page you came from. Generated at build time — do not edit by hand.",
  "",
  ...(lgpl.length ? [
    `${lgpl.map((p) => p.name).join(", ")} ${lgpl.length === 1 ? "is" : "are"} used under the GNU Lesser General Public`,
    "License v3 (LGPL-3.0), unchanged: the full texts of the LGPL-3.0 and of the GNU GPL v3, which it",
    "builds on, are at the end of this file; the library's own source is at the address in its section.",
    "",
  ] : []),
  "| Package | Version | Licence |",
  "|---|---|---|",
  ...pkgs.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  "",
];
for (const p of pkgs) {
  lines.push("---", "", `## ${p.name} ${p.version} — ${p.license}`, "");
  if (/LGPL/i.test(p.license) && p.repo) lines.push(`Source: ${p.repo}`, "");
  lines.push(p.text ?? `(No licence file is shipped in this package; its package.json declares \`${p.license}\`.)`, "");
}
if (lgpl.length) {
  const here = fileURLToPath(new URL("licenses/", import.meta.url));
  for (const f of ["LGPL-3.0.txt", "GPL-3.0.txt"]) lines.push("---", "", `## ${f.replace(/\.txt$/, "")} — full text`, "", "```", readFileSync(join(here, f), "utf8").trimEnd(), "```", "");
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n"));
const missing = pkgs.filter((p) => !p.text).length;
process.stdout.write(`notices: ${out} — ${pkgs.length} packages${missing ? `, ${missing} without a licence file` : ""}\n`);
