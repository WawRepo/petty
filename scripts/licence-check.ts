/**
 * PETTY-384: every package Petty installs carries a licence that can ship with AGPL-3.0-only code.
 * CI runs it on every push and pull request (the test job, after `pnpm install`), so a Dependabot
 * update that brings in another licence fails its checks and the twice-daily timer does not merge it.
 *
 *   node scripts/licence-check.ts             # asks pnpm (`pnpm licenses list --json -r`)
 *   node scripts/licence-check.ts --from x.json   # reads that output from a file (the tests)
 *
 * Dev dependencies are checked too, not only `--prod`: some of them end up inside what Petty serves
 * (vite-plugin-pwa puts Workbox into the service worker; esbuild bundles packages such as fflate into
 * petty.mcpb and petty.mjs). The shipped notices themselves are checked by
 * tests/integration/test/10-licences.test.ts.
 *
 * A licence is an SPDX expression: `A OR B` passes when either side does, `A AND B` when both do, and
 * `A WITH exception` when A does (an SPDX exception only adds permissions). Anything else — no licence,
 * UNLICENSED, "SEE LICENSE IN …", a licence not listed below — fails, by name. To allow a new licence,
 * check that it can ship with AGPL-3.0 code (the FSF's list of GPL-compatible licences), then add it
 * here with the reason in the commit.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** Licences that can ship with AGPL-3.0-only code (FSF: GPL-compatible, or GPLv3-compatible). */
export const ALLOWED: ReadonlySet<string> = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "BlueOak-1.0.0",
  "Unlicense", "CC0-1.0", "CC-BY-4.0", "Python-2.0", "Zlib", "MPL-2.0",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later",
  "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later",
]);

/** Older SPDX ids that package.json files still use, and what they mean today. */
const ALIASES: Record<string, string> = {
  "LGPL-2.1": "LGPL-2.1-only", "LGPL-2.1+": "LGPL-2.1-or-later", "LGPL-3.0": "LGPL-3.0-only", "LGPL-3.0+": "LGPL-3.0-or-later",
  "GPL-2.0+": "GPL-2.0-or-later", "GPL-3.0": "GPL-3.0-only", "GPL-3.0+": "GPL-3.0-or-later",
  "AGPL-3.0": "AGPL-3.0-only", "AGPL-3.0+": "AGPL-3.0-or-later",
};

/** Whether an SPDX licence expression passes. A string that is not a well-formed expression fails. */
export function allowed(expression: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  // or := and ("OR" and)* ; and := atom ("AND" atom)* ; atom := "(" or ")" | id ["WITH" id]
  const atom = (): boolean => {
    const t = tokens[i++];
    if (t === "(") { const v = or(); if (tokens[i++] !== ")") throw new Error("unbalanced"); return v; }
    if (t === undefined || t === ")" || /^(AND|OR|WITH)$/i.test(t)) throw new Error("not an expression");
    if (/^WITH$/i.test(tokens[i] ?? "")) { i++; if (!tokens[i++]) throw new Error("WITH needs an exception"); }
    return ALLOWED.has(ALIASES[t] ?? t);
  };
  const and = (): boolean => { let v = atom(); while (/^AND$/i.test(tokens[i] ?? "")) { i++; v = atom() && v; } return v; };
  const or = (): boolean => { let v = and(); while (/^OR$/i.test(tokens[i] ?? "")) { i++; v = and() || v; } return v; };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

interface Entry { name: string; versions?: string[]; license?: string }

/** The packages whose licence does not pass, as "name@versions: licence" lines. */
export function refused(list: Record<string, Entry[]>): string[] {
  const out: string[] = [];
  for (const [key, entries] of Object.entries(list)) {
    for (const e of entries) {
      const licence = e.license ?? key;
      if (!allowed(licence)) out.push(`${e.name}@${(e.versions ?? []).join(",")}: ${licence}`);
    }
  }
  return out.sort();
}

if (import.meta.main) {
  const { values: opt } = parseArgs({ options: { from: { type: "string" } } });
  const json = opt.from
    ? readFileSync(opt.from, "utf8")
    : execFileSync("pnpm", ["licenses", "list", "--json", "-r"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const list = JSON.parse(json) as Record<string, Entry[]>;
  const count = Object.values(list).reduce((n, entries) => n + entries.length, 0);
  // an empty list passes nothing: pnpm without -r, or before install, prints {}
  if (count === 0) { console.error("licence-check: pnpm listed no packages (run `pnpm install` first)"); process.exit(1); }
  const bad = refused(list);
  if (bad.length) {
    console.error(`licence-check: ${bad.length} package(s) have a licence that is not allowed with AGPL-3.0-only (scripts/licence-check.ts):`);
    for (const line of bad) console.error(`  ${line}`);
    process.exit(1);
  }
  process.stdout.write(`licence-check: ${count} packages, every licence allowed\n`);
}
