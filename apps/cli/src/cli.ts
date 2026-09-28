import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenError, type AgentClient, type AgentDrawer, type AgentEntry, type AgentPlace, type AgentTag } from "@petty/agent";
import { foldText } from "@petty/ledger";
import { buildServer } from "@petty/mcp/server";
import pkg from "../package.json" with { type: "json" };
import { COMMANDS, EXPIRES, SHELLS, commandOf, type CommandSpec } from "./commands.js";
import { candidates, forShell, script, unquote, type Names, type Shell } from "./complete.js";
import { CliError, type Io } from "./io.js";
import { itemLabel, placePaths, resolveItem, splitPlace } from "./items.js";
import { apiOf, checkToken, deviceLogin, originOf } from "./login.js";
import { forgetLogin, openToOthers, readStore, saveLogin, storePath } from "./store.js";

/**
 * `petty`, Petty from the command line (PETTY-274). A thin layer over @petty/agent, the client the MCP
 * server uses too: the token's keys are opened in this process and the drawers are decrypted here. Only
 * the login is stored (store.ts); nothing read from Petty is written to disk.
 *
 * Exit codes: 0 done, 1 error, 2 usage, 3 not signed in / token ended / read-only, 4 not found or unclear.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  try {
    await main(argv, io);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`petty: ${e.message}\n`);
      return e.exitCode;
    }
    if (e instanceof TokenError) {
      io.err(`petty: ${e.code}: ${e.message}\n`);
      return ["WrongToken", "TokenRevoked", "ReadOnly", "OutOfScope"].includes(e.code) ? 3 : ["NotFound", "Ambiguous"].includes(e.code) ? 4 : 1;
    }
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      io.err(`petty: ${(e as Error).message}\nRun petty help for the commands.\n`);
      return 2;
    }
    io.err(`petty: ${(e as Error).message}\n`);
    return 1;
  }
}

/** Names come from other people too: control characters would reach the terminal, so they are shown as "?". */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this replaces
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
const json = (io: Io, v: unknown) => io.out(`${JSON.stringify(v, null, 2)}\n`);

async function main(argv: readonly string[], io: Io): Promise<void> {
  const first = argv[0];
  if (first === "__complete") return complete(argv.slice(1), io);
  if (first === undefined || first === "help" || first === "--help" || first === "-h") return help(io, first === "help" ? argv.slice(1) : []);
  if (first === "--version" || first === "-v") return io.out(`petty ${pkg.version}\n`);
  const found = commandOf(argv);
  if (!found || found.spec.hidden) throw new CliError(2, `no command ${JSON.stringify(argv.slice(0, first === "auth" ? 2 : 1).join(" "))}. Run petty help for the commands.`);
  const { spec, used } = found;
  const rest = argv.slice(used);
  if (rest.includes("--help") || rest.includes("-h")) return io.out(usage(spec));
  const { values: v, positionals } = parseArgs({
    args: [...rest],
    options: Object.fromEntries(spec.flags.map((f) => [f.name, { type: f.value ? ("string" as const) : ("boolean" as const), ...(f.short ? { short: f.short } : {}) }])),
    strict: true,
    allowPositionals: true,
  });
  const flag = (name: string) => v[name] as string | undefined;
  const on = (name: string) => v[name] === true;
  const needed = spec.args.filter((a) => !a.optional).length;
  if (positionals.length < needed) throw new CliError(2, `missing ${spec.args.slice(positionals.length).filter((a) => !a.optional).map((a) => `<${a.name}>`).join(" ")}\n${usage(spec)}`);
  if (!spec.args.some((a) => a.rest) && positionals.length > spec.args.length) throw new CliError(2, `too many words: ${JSON.stringify(positionals.slice(spec.args.length).join(" "))} (quote a name with spaces)`);
  const arg = (i: number) => positionals[i]!;

  switch (spec.name) {
    case "auth login": return login(io, flag("host"), on("read-only"), flag("expires"), on("with-token"), !on("no-browser"));
    case "auth status": return status(io, flag("host"), on("json"));
    case "auth logout": return logout(io, flag("host"));
    case "auth token": return io.out(`${credentials(io, flag("host")).token}\n`);
    case "completion": {
      const shell = positionals[0] ?? flag("shell");
      if (!shell || !(SHELLS as readonly string[]).includes(shell)) throw new CliError(2, "say which shell: petty completion -s bash|zsh|fish|powershell");
      return io.out(script(shell as Shell));
    }
    case "mcp": return mcp(io, flag("host"), on("print-config"));
  }

  const client = await clientFor(io, flag("host"));
  const asJson = on("json");
  switch (spec.name) {
    case "drawers": {
      let list = await client.drawers();
      const place = flag("place");
      if (place) {
        const want = splitPlace(place).map(foldText);
        list = list.filter((d) => want.every((p, i) => foldText(d.place[i] ?? "") === p));
      }
      const tag = flag("tag");
      if (tag) list = list.map((d) => ({ ...d, lines: d.lines.filter((l) => l.tags.some((t) => foldText(t) === foldText(tag))) })).filter((d) => d.lines.length);
      return asJson ? json(io, list) : io.out(drawersText(list));
    }
    case "find": {
      const hit = await resolveItem(client, positionals.join(" "));
      return asJson ? json(io, { drawer: { id: hit.drawer.id, name: hit.drawer.name, place: hit.drawer.place }, item: hit.line }) : io.out(`${clean(itemLabel(hit.drawer, hit.line))}  ${hit.line.amount || "single item"}  (${hit.drawer.id}/${hit.line.id})\n`);
    }
    case "history": {
      const hit = await resolveItem(client, arg(0));
      const limit = flag("limit") ? Number(flag("limit")) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new CliError(2, "--limit takes a whole number from 1 to 500");
      const entries = await client.history(hit.drawer.id, hit.line.id, limit);
      return asJson ? json(io, entries) : io.out(historyText(entries));
    }
    case "add":
    case "take":
    case "adjust": {
      const hit = await resolveItem(client, arg(0));
      const noteFlag = flag("note");
      const note = noteFlag === "-" ? (await io.stdin()).trim() : (noteFlag ?? "");
      const amount = arg(1);
      const entry = spec.name === "add" ? await client.add(hit.drawer.id, hit.line.id, amount, note)
        : spec.name === "take" ? await client.withdraw(hit.drawer.id, hit.line.id, amount, note)
        : await client.adjust(hit.drawer.id, hit.line.id, amount, note);
      return asJson ? json(io, { drawer: hit.drawer.id, item: hit.line.id, ...entry }) : io.out(`${clean(itemLabel(hit.drawer, hit.line))}: ${entry.balanceAfter ?? entry.amount}\n`);
    }
    case "tags": {
      const tags = await client.tags();
      return asJson ? json(io, tags) : io.out(tagsText(tags));
    }
    case "places": {
      const places = await client.places();
      return asJson ? json(io, places) : io.out(placesText(places));
    }
    case "tag":
    case "untag": {
      const hit = await resolveItem(client, arg(0));
      const now = spec.name === "tag" ? await client.tagItem(hit.drawer.id, hit.line.id, arg(1)) : await client.untagItem(hit.drawer.id, hit.line.id, arg(1));
      return asJson ? json(io, { drawer: hit.drawer.id, item: hit.line.id, tags: now }) : io.out(`${clean(itemLabel(hit.drawer, hit.line))}: ${now.length ? now.map((t) => `#${clean(t)}`).join(" ") : "no tags"}\n`);
    }
    case "move": {
      const drawer = await client.findDrawer(arg(0));
      const now = await client.moveDrawer(drawer.id, splitPlace(arg(1)));
      return asJson ? json(io, { drawer: drawer.id, place: now }) : io.out(`${clean(drawer.name)}: ${now.length ? clean(now.join(" › ")) : "no place"}\n`);
    }
  }
  throw new CliError(2, `no command ${spec.name}`);
}

// ---------------------------------------------------------------------------------------------- login

function expiresOf(value: string | undefined): 30 | 90 | 365 | null {
  if (value === undefined) return 90;
  if (value === "never") return null;
  const n = Number(value.replace(/d$/, ""));
  if (n === 30 || n === 90 || n === 365) return n;
  throw new CliError(2, `--expires takes ${EXPIRES.join(", ")}`);
}

async function login(io: Io, host: string | undefined, readOnly: boolean, expires: string | undefined, withToken: boolean, browser: boolean): Promise<void> {
  const store = readStore(io.env);
  let where = host ?? io.env["PETTY_HOST"] ?? (Object.keys(store.hosts).length === 1 ? store.default ?? undefined : undefined);
  if (!where) where = (await io.ask("Your Petty's address (like https://petty.example.com): ")) || undefined;
  if (!where) throw new CliError(2, "say which Petty: petty auth login --host https://<your Petty>");
  const origin = originOf(where);
  const token = withToken
    ? (await io.stdin()).trim()
    : await deviceLogin(io, { origin, role: readOnly ? "read" : "write", expiresDays: expiresOf(expires), browser });
  const client = await checkToken(io, origin, token);
  const id = client.identity;
  saveLogin(io.env, origin, { token, name: id.name, role: id.role, user_id: id.userId, added_at: new Date(io.now()).toISOString() });
  io.err(`Signed in to ${origin} with the token “${clean(id.name)}” (${id.role === "write" ? "may add entries" : "read only"}). Kept in ${storePath(io.env)}.\n`);
}

async function status(io: Io, host: string | undefined, asJson: boolean): Promise<void> {
  const store = readStore(io.env);
  const origins = host ? [originOf(host)] : Object.keys(store.hosts);
  if (!origins.length && !io.env["PETTY_TOKEN"]) throw new CliError(3, "not signed in: run petty auth login --host https://<your Petty>");
  const rows: { host: string; token: string | null; role: string | null; default: boolean; works: boolean; problem: string | null; from: string }[] = [];
  if (io.env["PETTY_TOKEN"]) {
    const c = credentials(io, host);
    rows.push({ host: c.origin, ...(await probe(io, c.origin, c.token)), default: true, from: "PETTY_TOKEN" });
  }
  for (const o of origins) {
    const login = store.hosts[o];
    if (!login) { rows.push({ host: o, token: null, role: null, default: false, works: false, problem: "not signed in", from: storePath(io.env) }); continue; }
    rows.push({ host: o, ...(await probe(io, o, login.token)), default: store.default === o, from: storePath(io.env) });
  }
  if (asJson) json(io, rows);
  else for (const r of rows) {
    io.out(`${r.host}${r.default && rows.length > 1 ? "  (default)" : ""}\n  ${r.works ? `signed in with the token “${clean(r.token ?? "")}”, ${r.role === "write" ? "may add entries" : "read only"}` : `✗ ${r.problem}`}\n  token kept in ${r.from}\n`);
  }
  if (openToOthers(storePath(io.env))) io.err(`petty: warning: ${storePath(io.env)} can be read by other users; run: chmod 600 ${storePath(io.env)}\n`);
  if (rows.some((r) => !r.works)) throw new CliError(3, "a login does not work: run petty auth login again");
}

async function probe(io: Io, origin: string, token: string): Promise<{ token: string | null; role: string | null; works: boolean; problem: string | null }> {
  try {
    const c = await checkToken(io, origin, token);
    return { token: c.identity.name, role: c.identity.role, works: true, problem: null };
  } catch (e) {
    return { token: null, role: null, works: false, problem: e instanceof TokenError ? `${e.code}: ${e.message}` : (e as Error).message };
  }
}

async function logout(io: Io, host: string | undefined): Promise<void> {
  const store = readStore(io.env);
  const origin = host ? originOf(host) : store.default;
  const login = origin ? store.hosts[origin] : undefined;
  if (!origin || !login) throw new CliError(3, "not signed in there: nothing to sign out of");
  let ended = false;
  try {
    const res = await io.fetch(`${apiOf(origin)}/me/token`, { method: "DELETE", headers: { authorization: `Bearer ${login.token.split(".")[0]}` } });
    ended = res.status === 204 || res.status === 401; // 401: it had already ended
  } catch { /* offline: say so below */ }
  forgetLogin(io.env, origin);
  io.err(ended
    ? `Signed out of ${origin}: the token “${clean(login.name)}” is ended there and forgotten here.\n`
    : `Forgotten here, but ${origin} could not be reached to end the token: revoke “${clean(login.name)}” in Settings → Access tokens.\n`);
}

/** The token and Petty to use: PETTY_TOKEN first (for scripts and CI), then the stored login. */
function credentials(io: Io, host: string | undefined): { origin: string; token: string } {
  const envToken = io.env["PETTY_TOKEN"]?.trim();
  if (envToken) {
    const where = host ?? io.env["PETTY_API_URL"] ?? io.env["PETTY_HOST"];
    if (!where) throw new CliError(2, "PETTY_TOKEN is set: say which Petty with --host or PETTY_API_URL");
    return { origin: originOf(where), token: envToken };
  }
  const store = readStore(io.env);
  const origin = host ? originOf(host) : io.env["PETTY_HOST"] ? originOf(io.env["PETTY_HOST"]) : store.default;
  const login = origin ? store.hosts[origin] : undefined;
  if (!origin || !login) throw new CliError(3, origin ? `not signed in to ${origin}: run petty auth login --host ${origin}` : "not signed in: run petty auth login --host https://<your Petty>");
  if (openToOthers(storePath(io.env))) io.err(`petty: warning: ${storePath(io.env)} can be read by other users; run: chmod 600 ${storePath(io.env)}\n`);
  return { origin, token: login.token };
}

async function clientFor(io: Io, host: string | undefined): Promise<AgentClient> {
  const c = credentials(io, host);
  return checkToken(io, c.origin, c.token);
}

// ------------------------------------------------------------------------------------------------ mcp

async function mcp(io: Io, host: string | undefined, printConfig: boolean): Promise<void> {
  const c = credentials(io, host);
  if (printConfig) {
    const self = io.env["PETTY_SELF"] ?? fileURLToPath(import.meta.url);
    // the app starts `petty mcp` without this shell's variables: it uses the login petty auth login stored
    if (io.env["PETTY_TOKEN"]) io.err("petty: note: the app will not see PETTY_TOKEN; run petty auth login first, or add PETTY_TOKEN and PETTY_API_URL to the block's \"env\"\n");
    return json(io, { mcpServers: { petty: { command: process.execPath, args: [self, "mcp", ...(host ? ["--host", c.origin] : [])] } } });
  }
  const server = await buildServer({ token: c.token, apiUrl: apiOf(c.origin) });
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => { process.stdin.once("close", resolve); process.stdin.once("end", resolve); });
}

// ----------------------------------------------------------------------------------------- completion

async function complete(args: readonly string[], io: Io): Promise<void> {
  const fromEnv = io.env["PETTY_COMPLETE_CURRENT"];
  const cur = unquote(fromEnv !== undefined ? fromEnv.replace(/^=/, "") : (args.at(-1) ?? ""));
  const prior = (fromEnv !== undefined ? args : args.slice(0, -1)).map(unquote);
  const hosts = Object.keys(readStore(io.env).hosts);
  let cached: Promise<Names | null> | null = null;
  const names = () => (cached ??= liveNames(io, prior));
  for (const c of await candidates(prior, cur, names, hosts)) io.out(`${forShell(io.env["PETTY_COMPLETE_SHELL"], c)}\n`);
}

/** Names for this Tab press: decrypted in memory with the stored login, within 1.5 s, else none. */
async function liveNames(io: Io, prior: readonly string[]): Promise<Names | null> {
  if (io.env["PETTY_COMPLETE_NAMES"] === "0") return null;
  const hostAt = prior.findIndex((w) => w === "--host" || w.startsWith("--host="));
  const host = hostAt < 0 ? undefined : prior[hostAt]!.includes("=") ? prior[hostAt]!.split("=")[1] : prior[hostAt + 1];
  const work = (async (): Promise<Names> => {
    const client = await clientFor({ ...io, err: () => undefined }, host);
    const drawers: AgentDrawer[] = await client.drawers();
    const [tags, places] = await Promise.all([client.tags(), client.places()]);
    return {
      items: drawers.flatMap((d) => d.lines.map((l) => itemLabel(d, l))),
      drawers: drawers.map((d) => d.name),
      tags: tags.map((t) => t.label),
      places: placePaths(places),
      itemTags: async (item) => (await resolveItem(client, item)).line.tags,
    };
  })();
  return Promise.race([work.catch(() => null), io.sleep(1500).then(() => null)]);
}

// ------------------------------------------------------------------------------------------- printing

function drawersText(list: readonly AgentDrawer[]): string {
  if (!list.length) return "No drawers.\n";
  const width = Math.max(8, ...list.flatMap((d) => d.lines.map((l) => [...l.name].length))) + 2;
  return list.map((d) => {
    const head = `${clean(d.name)}${d.place.length ? `  (${clean(d.place.join(" › "))})` : ""}${d.role === "read" ? "  read only" : ""}`;
    const lines = d.lines.map((l) => {
      const amount = l.kind === "single" ? "single item" : l.amount;
      const tags = l.tags.length ? `  ${l.tags.map((t) => `#${clean(t)}`).join(" ")}` : "";
      const warn = l.unverified ? `  ! ${l.unverified} unverified entr${l.unverified === 1 ? "y" : "ies"} left out` : "";
      return `  ${clean(l.name).padEnd(width)}${amount}${l.countedInTotal || l.kind === "single" ? "" : "  (not in total)"}${tags}${warn}`;
    });
    return [head, ...(lines.length ? lines : ["  (no items)"])].join("\n");
  }).join("\n\n") + "\n";
}

function historyText(entries: readonly AgentEntry[]): string {
  if (!entries.length) return "No entries yet.\n";
  return entries.map((e) => `${e.at.slice(0, 16).replace("T", " ")}  ${e.op.padEnd(8)}${e.amount}${e.comment ? `  ${JSON.stringify(clean(e.comment))}` : ""}${e.verified ? "" : "  ! signature did not check"}`).join("\n") + "\n";
}

function tagsText(tags: readonly AgentTag[]): string {
  if (!tags.length) return "No tags.\n";
  return tags.map((t) => `#${clean(t.label)}: ${t.holders.flatMap((h) => h.items.map((i) => clean(`${h.drawer} › ${i.name}`))).join(", ")}`).join("\n") + "\n";
}

function placesText(roots: readonly AgentPlace[]): string {
  if (!roots.length) return "No places.\n";
  const out: string[] = [];
  const walk = (p: AgentPlace, depth: number) => {
    out.push(`${"  ".repeat(depth)}${clean(p.name)}${p.drawers.length ? `: ${p.drawers.map(clean).join(", ")}` : ""}`);
    p.children.forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return `${out.join("\n")}\n`;
}

function usage(spec: CommandSpec): string {
  const args = spec.args.map((a) => (a.optional ? `[${a.name}]` : a.rest ? `<${a.name}…>` : `<${a.name}>`)).join(" ");
  const flags = spec.flags.map((f) => `  ${`${f.short ? `-${f.short}, ` : ""}--${f.name}${f.value ? ` <${f.value}>` : ""}`.padEnd(26)}${f.help}`).join("\n");
  return `Usage: petty ${spec.name}${args ? ` ${args}` : ""}${spec.flags.length ? " [flags]" : ""}\n\n${spec.help}\n${flags ? `\n${flags}\n` : ""}`;
}

function help(io: Io, topic: readonly string[]): void {
  const found = topic.length ? commandOf(topic) : null;
  if (found) return io.out(usage(found.spec));
  const row = (c: CommandSpec) => `  ${c.name.padEnd(14)}${c.help}`;
  const shown = COMMANDS.filter((c) => !c.hidden);
  io.out(`petty ${pkg.version}: Petty from the command line.

Usage: petty <command> [flags]

Sign in
${shown.filter((c) => c.name.startsWith("auth ")).map(row).join("\n")}

Read
${shown.filter((c) => ["drawers", "find", "history", "tags", "places"].includes(c.name)).map(row).join("\n")}

Change
${shown.filter((c) => ["add", "take", "adjust", "tag", "untag", "move"].includes(c.name)).map(row).join("\n")}

More
${shown.filter((c) => ["mcp", "completion"].includes(c.name)).map(row).join("\n")}

Name an item as "Drawer › Item" (Tab completes it), by words, or by the drawerId/itemId --json prints.
Every command takes --host <address> and, where it prints, --json. petty help <command> tells more.
Docs: https://github.com/WawRepo/petty/blob/main/docs/cli.md
`);
}
