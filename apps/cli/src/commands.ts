/**
 * The one table of `petty`'s commands (PETTY-274). Parsing, `--help` and Tab completion all read it, so
 * they cannot drift apart.
 */
export type ValueKind = "host" | "expires" | "shell" | "text" | "number" | "place" | "tag";
export type ArgKind = "item" | "drawer" | "tag" | "itemTag" | "place" | "text" | "amount" | "shell";

export interface FlagSpec {
  readonly name: string;
  readonly short?: string;
  /** What the flag takes; none = a switch. */
  readonly value?: ValueKind;
  readonly help: string;
}
export interface ArgSpec {
  readonly name: string;
  readonly kind: ArgKind;
  readonly optional?: boolean;
  /** Takes every word left (a search phrase). */
  readonly rest?: boolean;
}
export interface CommandSpec {
  /** "auth login", "drawers"… */
  readonly name: string;
  readonly help: string;
  readonly args: readonly ArgSpec[];
  readonly flags: readonly FlagSpec[];
  /** Hidden from help and completion. */
  readonly hidden?: boolean;
}

const JSON_FLAG: FlagSpec = { name: "json", help: "print JSON, for scripts and AI agents" };
const HOST: FlagSpec = { name: "host", value: "host", help: "which Petty, for example https://petty.example.com" };
const NOTE: FlagSpec = { name: "note", value: "text", help: "a comment on the entry; - reads it from stdin (it stays out of shell history)" };
export const EXPIRES = ["30", "90", "365", "never"] as const;
export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "auth login", help: "sign in through a page of Petty in your browser, or with an access token", args: [],
    flags: [
      HOST,
      { name: "read-only", help: "ask only to read (by default it may also add entries)" },
      { name: "expires", value: "expires", help: "days until the token ends: 30, 90 (default), 365 or never" },
      { name: "with-token", help: "read an access token (petty_pat_…) from stdin instead" },
      { name: "no-browser", help: "print the page's address instead of opening it" },
    ],
  },
  { name: "auth status", help: "show where you are signed in, and check the token still works", args: [], flags: [HOST, JSON_FLAG] },
  { name: "auth logout", help: "end the token on the server and forget it here", args: [], flags: [HOST] },
  { name: "auth token", help: "print the stored token", args: [], flags: [HOST] },
  { name: "drawers", help: "every drawer with its items and balances", args: [], flags: [{ name: "place", value: "place", help: "only drawers in this place and below it" }, { name: "tag", value: "tag", help: "only items with this tag" }, HOST, JSON_FLAG] },
  { name: "find", help: "the one item these words name", args: [{ name: "words", kind: "item", rest: true }], flags: [HOST, JSON_FLAG] },
  { name: "history", help: "an item's latest entries, newest first", args: [{ name: "item", kind: "item" }], flags: [{ name: "limit", value: "number", help: "how many (default 20)" }, HOST, JSON_FLAG] },
  { name: "add", help: "put an amount in", args: [{ name: "item", kind: "item" }, { name: "amount", kind: "amount" }], flags: [NOTE, HOST, JSON_FLAG] },
  { name: "take", help: "take an amount out", args: [{ name: "item", kind: "item" }, { name: "amount", kind: "amount" }], flags: [NOTE, HOST, JSON_FLAG] },
  { name: "adjust", help: "set what you counted", args: [{ name: "item", kind: "item" }, { name: "counted", kind: "amount" }], flags: [NOTE, HOST, JSON_FLAG] },
  { name: "tags", help: "every tag and the items carrying it", args: [], flags: [HOST, JSON_FLAG] },
  { name: "places", help: "the place tree", args: [], flags: [HOST, JSON_FLAG] },
  { name: "tag", help: "put a tag on an item", args: [{ name: "item", kind: "item" }, { name: "tag", kind: "tag" }], flags: [HOST, JSON_FLAG] },
  { name: "untag", help: "take a tag off an item", args: [{ name: "item", kind: "item" }, { name: "tag", kind: "itemTag" }], flags: [HOST, JSON_FLAG] },
  { name: "move", help: "move a drawer to a place (\"House › Kitchen\"; \"\" for none)", args: [{ name: "drawer", kind: "drawer" }, { name: "place", kind: "place" }], flags: [HOST, JSON_FLAG] },
  { name: "mcp", help: "run the MCP server for AI apps (Claude Desktop) with this login", args: [], flags: [HOST, { name: "print-config", help: "print the settings block for an MCP app" }] },
  { name: "completion", help: "print the Tab completion script for a shell", args: [{ name: "shell", kind: "shell", optional: true }], flags: [{ name: "shell", short: "s", value: "shell", help: "bash, zsh, fish or powershell" }] },
  { name: "__complete", help: "", args: [], flags: [], hidden: true },
];

export const GROUPS = ["auth"] as const;

/** The command a list of words starts with, and how many words its name takes. */
export function commandOf(words: readonly string[]): { spec: CommandSpec; used: number } | null {
  const two = COMMANDS.find((c) => c.name === `${words[0]} ${words[1]}`);
  if (two) return { spec: two, used: 2 };
  const one = COMMANDS.find((c) => c.name === words[0] && !c.name.includes(" "));
  return one ? { spec: one, used: 1 } : null;
}
