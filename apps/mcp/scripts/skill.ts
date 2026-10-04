/**
 * PETTY-310: reads an Agent Skill folder (agentskills.io/specification) and checks its SKILL.md
 * frontmatter the way `skills-ref validate` does, without fetching that tool: the fields the
 * specification defines and nothing else, `name` equal to the folder name, the length limits.
 * The frontmatter is a small YAML subset (plain `key: value` lines and a one-level `metadata` map);
 * anything outside it is refused rather than guessed at.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, string>>;
  /** The Markdown after the frontmatter. */
  readonly body: string;
}

const FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A plain YAML scalar this parser can take as it is: no quoting, no indicator in front, no ": " or " #". */
function plain(value: string, where: string): string {
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) || value.includes(": ") || value.includes(" #") || value.endsWith(":")) throw new Error(`${where}: write it as a plain value (no quotes, no ": " or " #")`);
  return value;
}

export function readSkill(dir: string): Skill {
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("SKILL.md must start with a --- frontmatter block");
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  for (const line of m[1]!.split("\n")) {
    const nested = /^ {2}([A-Za-z0-9_-]+): (.+)$/.exec(line);
    if (nested && inMetadata) {
      metadata[nested[1]!] = plain(nested[2]!, `metadata.${nested[1]}`);
      continue;
    }
    const top = /^([a-z-]+):(?: (.+))?$/.exec(line);
    if (!top) throw new Error(`frontmatter line not understood: ${JSON.stringify(line)}`);
    const [, key, value] = top as unknown as [string, string, string | undefined];
    if (!FIELDS.has(key)) throw new Error(`frontmatter field ${key} is not in the Agent Skills specification`);
    if (key in fields) throw new Error(`frontmatter field ${key} appears twice`);
    inMetadata = key === "metadata";
    if (inMetadata) {
      if (value !== undefined) throw new Error("metadata must be a map of key: value lines");
      fields[key] = "";
      continue;
    }
    if (value === undefined) throw new Error(`frontmatter field ${key} is empty`);
    fields[key] = plain(value, key);
  }
  const name = fields["name"] ?? "";
  const description = fields["description"] ?? "";
  if (!NAME.test(name) || name.length > 64) throw new Error(`name ${JSON.stringify(name)}: 1-64 lowercase letters, digits and single hyphens`);
  if (name !== basename(resolve(dir))) throw new Error(`name ${name} must equal the folder name ${basename(resolve(dir))}`);
  if (!description || description.length > 1024) throw new Error(`description: 1-1024 characters (it has ${description.length})`);
  if (fields["compatibility"] !== undefined && fields["compatibility"].length > 500) throw new Error("compatibility: at most 500 characters");
  return { name, description, fields, metadata, body: m[2]! };
}
