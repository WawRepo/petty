/** Fails when en.json and pl.json do not have exactly the same keys, or any value is empty. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const en = flatten(load("en.json"));
const pl = flatten(load("pl.json"));
const problems: string[] = [];
for (const k of en.keys()) if (!pl.has(k)) problems.push(`missing in pl.json: ${k}`);
for (const k of pl.keys()) if (!en.has(k)) problems.push(`missing in en.json: ${k}`);
for (const [k, v] of [...en, ...pl]) if (v.trim() === "") problems.push(`empty value: ${k}`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
process.stdout.write(`i18n ok: ${en.size} keys in en and pl\n`);
