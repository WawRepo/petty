/**
 * Fails the build when a dictionary is not a faithful translation of en.json (PETTY-249):
 * - every locale has exactly the keys of en.json (arrays included), and no value is empty;
 * - every value parses as an ICU message in its locale;
 * - every message uses the same arguments ({name}, {count}, …) as the English one;
 * - plural and select branches use categories that exist in that language (and always `other`).
 * `pnpm i18n:check` checks every dictionary; `pnpm exec tsx scripts/i18n-check.ts de` checks one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";

const dir = fileURLToPath(new URL("../src/i18n/", import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(dir + f, "utf8")) as Record<string, unknown>;
function flatten(o: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) for (const [kk, vv] of flatten(v as Record<string, unknown>, key)) out.set(kk, vv);
    else out.set(key, String(v));
  }
  return out;
}

// intl-messageformat AST element types (@formatjs/icu-messageformat-parser TYPE)
const T = { argument: 1, number: 2, date: 3, time: 4, select: 5, plural: 6, tag: 8 } as const;
interface El { type: number; value?: string; options?: Record<string, { value: El[] }>; children?: El[]; pluralType?: string }
function walk(els: El[], args: Set<string>, plurals: string[][]): void {
  for (const e of els) {
    if (e.type === T.argument || e.type === T.number || e.type === T.date || e.type === T.time || e.type === T.select || e.type === T.plural) args.add(e.value!);
    if (e.type === T.plural) plurals.push(Object.keys(e.options ?? {}));
    if (e.options) for (const o of Object.values(e.options)) walk(o.value, args, plurals);
    if (e.type === T.tag && e.children) walk(e.children, args, plurals);
  }
}
function analyse(msg: string, locale: string): { args: Set<string>; plurals: string[][] } {
  const ast = new IntlMessageFormat(msg, locale, undefined, { ignoreTag: true }).getAst() as unknown as El[];
  const args = new Set<string>();
  const plurals: string[][] = [];
  walk(ast, args, plurals);
  return { args, plurals };
}

// `tsx scripts/i18n-check.ts de` checks one dictionary (against en.json); no argument checks them all.
const only = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && (!only || f === `${only}.json`)).sort();
if (only && !files.length) { console.error(`no ${only}.json in src/i18n`); process.exit(1); }
const en = flatten(load("en.json"));
const problems: string[] = [];
const sizes: string[] = [];
for (const f of files) {
  const locale = f.replace(/\.json$/, "");
  const dict = flatten(load(f));
  sizes.push(`${locale} ${dict.size}`);
  const categories = new Set<string>(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
  for (const k of en.keys()) if (!dict.has(k)) problems.push(`${f}: missing ${k}`);
  for (const k of dict.keys()) if (!en.has(k)) problems.push(`${f}: not in en.json: ${k}`);
  for (const [k, v] of dict) {
    if (v.trim() === "") { problems.push(`${f}: empty ${k}`); continue; }
    let mine: ReturnType<typeof analyse>;
    try { mine = analyse(v, locale); } catch (e) { problems.push(`${f}: ${k} is not a valid ICU message (${(e as Error).message})`); continue; }
    const source = en.get(k);
    if (source !== undefined && locale !== "en") {
      const want = analyse(source, "en").args;
      const missing = [...want].filter((a) => !mine.args.has(a));
      const extra = [...mine.args].filter((a) => !want.has(a));
      if (missing.length || extra.length) problems.push(`${f}: ${k} arguments differ from English (missing: ${missing.join(",") || "–"}; extra: ${extra.join(",") || "–"})`);
    }
    for (const opts of mine.plurals) {
      if (!opts.includes("other")) problems.push(`${f}: ${k} has a plural without "other"`);
      for (const o of opts) if (!o.startsWith("=") && !categories.has(o)) problems.push(`${f}: ${k} uses plural category "${o}", which ${locale} does not have (${[...categories].join(", ")})`);
    }
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
process.stdout.write(`i18n ok: ${sizes.join(", ")} keys; every message parses, arguments and plurals match\n`);
