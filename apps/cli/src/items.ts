import { TokenError, type AgentClient, type AgentDrawer, type AgentLine, type AgentPlace } from "@petty/agent";
import { foldText } from "@petty/ledger";

/**
 * How a command names an item (PETTY-274). Three ways, tried in this order:
 *  - "<drawer id>/<item id>", as --json prints them;
 *  - "Drawer › Item", which is what Tab completes to (`>` works too);
 *  - words, the way the app's search finds an item ("kitchen cash").
 */
export const itemLabel = (d: AgentDrawer, l: AgentLine): string => `${d.name} › ${l.name}`;
const SPLIT = /\s+(?:›|>)\s+/;

export async function resolveItem(client: AgentClient, target: string): Promise<{ drawer: AgentDrawer; line: AgentLine }> {
  const ids = /^([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(target.trim());
  if (ids) {
    const drawer = (await client.drawers()).find((d) => d.id === ids[1]);
    const line = drawer?.lines.find((l) => l.id === ids[2]);
    if (drawer && line) return { drawer, line };
    throw new TokenError("NotFound", `no item ${target}`);
  }
  const parts = target.split(SPLIT);
  if (parts.length === 2) {
    const [dn, ln] = parts.map((p) => foldText(p.trim())) as [string, string];
    const hits = (await client.drawers()).flatMap((drawer) => drawer.lines.filter((l) => foldText(drawer.name) === dn && foldText(l.name) === ln).map((line) => ({ drawer, line })));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new TokenError("Ambiguous", `${JSON.stringify(target)} names ${hits.length} items: use the id from --json`);
    throw new TokenError("NotFound", `no item ${JSON.stringify(target)}`);
  }
  return client.find(target);
}

/** "House › Kitchen", "House > Kitchen" or "House/Kitchen" → ["House", "Kitchen"]. */
export const splitPlace = (place: string): string[] => place.split(/\s*(?:›|>|\/)\s*/).map((p) => p.trim()).filter(Boolean);

export function placePaths(roots: readonly AgentPlace[]): string[] {
  const out: string[] = [];
  const walk = (p: AgentPlace) => { out.push(p.path.join(" › ")); p.children.forEach(walk); };
  roots.forEach(walk);
  return out;
}
