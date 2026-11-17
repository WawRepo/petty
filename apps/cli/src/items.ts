import { quote, TokenError, type AgentClient, type AgentDrawer, type AgentLine, type AgentPlace } from "@petty/agent";
import { foldText } from "@petty/ledger";
import { CliError } from "./io.js";

/**
 * How a command names an item (PETTY-274). Four ways, tried in this order:
 *  - the item's page in the app, copied from the browser: https://petty.example/drawers/<id>/lines/<id> (PETTY-515);
 *  - "<drawer id>/<item id>", as --json prints them. The item's id may be one from before item ids had to be
 *    UUIDs (PETTY-414), also in the quoted form the AI add-on shows it in (PETTY-515);
 *  - "Drawer › Item", which is what Tab completes to (`>` works too);
 *  - words, the way the app's search finds an item ("kitchen cash").
 */
export const itemLabel = (d: AgentDrawer, l: AgentLine): string => `${d.name} › ${l.name}`;
const SPLIT = /\s+(?:›|>)\s+/;

/**
 * PETTY-452: a token made for chosen drawers does not see the others, so "not found" may mean "in a
 * drawer this token does not open". The answer then says how many drawers the token opens.
 */
function notFound(client: AgentClient, message: string): TokenError {
  const n = client.identity.scope?.length;
  return new TokenError("NotFound", n === undefined ? message : `${message} (this token opens only the ${n} drawer${n === 1 ? "" : "s"} chosen for it)`);
}
const orNotFound = (client: AgentClient) => (e: unknown): never => { throw e instanceof TokenError && e.code === "NotFound" ? notFound(client, e.message) : e; };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PETTY-515: the ids in a page address of the app, /drawers/<drawer id> or /drawers/<drawer id>/lines/<item id>.
 * Only the path counts: the ids are looked up in what this login opens, like the ids --json prints. null when
 * the text is not a web address at all; an address of any other page is a usage mistake.
 */
function pageIds(target: string): { drawer: string; line: string | null } | null {
  if (!/^https?:\/\//i.test(target)) return null;
  let path: string;
  try { path = new URL(target).pathname; } catch { return null; }
  const m = /^\/drawers\/([^/]+)(?:\/lines\/([^/]+))?\/?$/.exec(path);
  let ids: { drawer: string; line: string | null } | null = null;
  try { if (m) ids = { drawer: decodeURIComponent(m[1]!), line: m[2] === undefined ? null : decodeURIComponent(m[2]) }; } catch { /* a broken %-escape */ }
  if (!ids || !UUID.test(ids.drawer)) throw new CliError(2, `${quote(target)} is not the page of a drawer or an item in Petty`);
  return { drawer: ids.drawer.toLowerCase(), line: ids.line };
}

/** "<drawer id>/<item id>": the drawer's id is a UUID, the item's anything after the first slash. */
function idPair(target: string): { drawer: string; line: string } | null {
  const slash = target.indexOf("/");
  if (slash < 0 || !UUID.test(target.slice(0, slash)) || slash === target.length - 1) return null;
  return { drawer: target.slice(0, slash).toLowerCase(), line: target.slice(slash + 1) };
}

/** An item by its id: as it is, a UUID in either case, or quoted the way the AI add-on shows an older id. */
const lineById = (drawer: AgentDrawer, id: string): AgentLine | undefined =>
  drawer.lines.find((l) => l.id === id || quote(l.id) === id || (UUID.test(id) && l.id.toLowerCase() === id.toLowerCase()));

/** A drawer by its page, its id or its name, for `petty move`. */
export async function resolveDrawer(client: AgentClient, target: string): Promise<AgentDrawer> {
  const page = pageIds(target.trim());
  if (page?.line != null) throw new CliError(2, `${quote(target)} is an item's page: give the drawer's page, its id or its name`);
  const t = page ? page.drawer : UUID.test(target.trim()) ? target.trim().toLowerCase() : target;
  return client.findDrawer(t).catch(orNotFound(client));
}

export async function resolveItem(client: AgentClient, target: string): Promise<{ drawer: AgentDrawer; line: AgentLine }> {
  const page = pageIds(target.trim());
  if (page && page.line === null) throw new CliError(2, `${quote(target)} is a drawer's page: name an item, or give the item's page`);
  const ids = page ?? idPair(target.trim());
  if (ids) {
    const drawer = (await client.drawers()).find((d) => d.id === ids.drawer);
    const line = drawer && lineById(drawer, ids.line!);
    if (drawer && line) return { drawer, line };
    throw notFound(client, `no item ${quote(target)}`);
  }
  const parts = target.split(SPLIT);
  if (parts.length === 2) {
    const [dn, ln] = parts.map((p) => foldText(p.trim())) as [string, string];
    const hits = (await client.drawers()).flatMap((drawer) => drawer.lines.filter((l) => foldText(drawer.name) === dn && foldText(l.name) === ln).map((line) => ({ drawer, line })));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new TokenError("Ambiguous", `${quote(target)} names ${hits.length} items: use the id from --json`);
    throw notFound(client, `no item ${quote(target)}`);
  }
  return client.find(target).catch(orNotFound(client));
}

/** "House › Kitchen", "House > Kitchen" or "House/Kitchen" → ["House", "Kitchen"]. */
export const splitPlace = (place: string): string[] => place.split(/\s*(?:›|>|\/)\s*/).map((p) => p.trim()).filter(Boolean);

export function placePaths(roots: readonly AgentPlace[]): string[] {
  const out: string[] = [];
  const walk = (p: AgentPlace) => { out.push(p.path.join(" › ")); p.children.forEach(walk); };
  roots.forEach(walk);
  return out;
}
