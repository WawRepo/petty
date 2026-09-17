/**
 * Demo household for a local docker-compose run (`make demo`), through the real API
 * with real ciphertext. A family plus a club, several places, tags, shared drawers.
 *
 *   ania   — owns everything below; login `password-ania`,   vault passphrase `vault ania 2026 drawer`
 *   bartek — writer on the club drawers, reader on the kitchen; `password-bartek`, `vault bartek 2026 drawer`
 *   emails: ania@petty.local, bartek@petty.local
 *
 * Skips if ania exists; `make demo-reset` starts over.
 */
import pg from "pg";
import { hashEntry } from "@petty/crypto";
import { applyOps, newDocument, type DocumentOp } from "@petty/ledger";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

const uuid = () => crypto.randomUUID();
const ctx = { lineHasEntries: () => false };

async function main() {
  if (config.authProvider === "clerk") {
    // Local sign-up is off in Clerk mode (PETTY-88): people come in through Clerk and set up their own vault.
    process.stdout.write("seed-demo: Clerk mode — no seed users; sign in through Clerk on the demo and create a vault\n");
    return;
  }
  const owner = new pg.Client({ connectionString: config.ownerDatabaseUrl });
  await owner.connect();
  const exists = await owner.query("select 1 from users where email = 'ania@petty.local'");
  await owner.end();
  if (exists.rowCount) { process.stdout.write("seed-demo: ania already exists — `make demo-reset` to start over\n"); return; }

  const app = buildApp();
  await app.ready();
  const [ania, bartek] = await Promise.all([userMaterial("ania"), userMaterial("bartek")]);
  const A = new Client(app, ania), B = new Client(app, bartek);
  for (const c of [A, B]) {
    const r = await c.signup(await makeJoinLink());
    if (r.statusCode !== 201) throw new Error(`signup failed: ${r.body}`);
  }

  /** One drawer: lines, tags, a chain of entries per money line. Amounts in minor units. */
  async function drawer(name: string, tags: string[], lines: Array<{ id: string; op: DocumentOp }>, entries: Array<{ line: string; op: "add" | "withdraw"; amount: number }>) {
    const ops: DocumentOp[] = [...lines.map((l) => l.op), { type: "set_tags", tags }];
    const doc = applyOps(newDocument(name), ops, ctx);
    const { id, key, res } = await A.createDrawer(name, doc);
    if (res.statusCode !== 201) throw new Error(`drawer ${name}: ${res.body}`);
    const prev = new Map<string, string>();
    for (const e of entries) {
      const r = await A.postEntry(id, key, e.line, e.op, e.op === "withdraw" ? -Math.abs(e.amount) : e.amount, { prev_hash: prev.get(e.line) ?? null });
      if (r.res.statusCode !== 201) throw new Error(`entry in ${name}: ${r.res.body}`);
      prev.set(e.line, await hashEntry(r.signed));
    }
    return id;
  }
  const money = (id: string, name: string, currency: string): { id: string; op: DocumentOp } => ({ id, op: { type: "add_line", line: { id, kind: "money", name, currency, exponent: 2 } } });
  const countable = (id: string, name: string, unit: string): { id: string; op: DocumentOp } => ({ id, op: { type: "add_line", line: { id, kind: "countable", name, unit } } });
  const single = (id: string, name: string, text: string): { id: string; op: DocumentOp } => ({ id, op: { type: "add_line", line: { id, kind: "single", name, text } } });

  const k1 = uuid(), k2 = uuid(), k3 = uuid();
  const kitchen = await drawer("Kitchen drawer", ["Kitchen", "Home"], [money(k1, "Groceries", "PLN"), money(k2, "Holiday euros", "EUR"), single(k3, "Passports", "all four, expire 2031")], [
    { line: k1, op: "add", amount: 50000 }, { line: k1, op: "withdraw", amount: 12350 }, { line: k1, op: "withdraw", amount: 4800 }, { line: k1, op: "add", amount: 20000 },
    { line: k2, op: "add", amount: 45000 }, { line: k2, op: "withdraw", amount: 6000 },
  ]);
  const b1 = uuid(), b2 = uuid(), b3 = uuid();
  await drawer("Bedroom safe", ["Bedroom", "Home"], [money(b1, "Dollar savings", "USD"), money(b2, "Emergency zloty", "PLN"), single(b3, "Grandma's ring", "in the blue box")], [
    { line: b1, op: "add", amount: 120000 }, { line: b1, op: "add", amount: 30000 },
    { line: b2, op: "add", amount: 200000 },
  ]);
  const s1 = uuid(), s2 = uuid();
  await drawer("Shed box", ["Garden", "Shed"], [money(s1, "Coins for the mower man", "PLN"), countable(s2, "Spare keys", "keys")], [
    { line: s1, op: "add", amount: 15000 }, { line: s1, op: "withdraw", amount: 5000 },
    { line: s2, op: "add", amount: 3 },
  ]);
  const c1 = uuid(), c2 = uuid();
  const bar = await drawer("Bar float", ["Club", "Bar"], [money(c1, "Till float", "PLN"), money(c2, "Tips jar", "PLN")], [
    { line: c1, op: "add", amount: 80000 }, { line: c1, op: "withdraw", amount: 12000 }, { line: c1, op: "add", amount: 45500 },
    { line: c2, op: "add", amount: 7300 },
  ]);
  const o1 = uuid(), o2 = uuid();
  const office = await drawer("Club office safe", ["Club", "Office"], [money(o1, "Membership fees", "PLN"), money(o2, "Tournament euros", "EUR")], [
    { line: o1, op: "add", amount: 340000 }, { line: o1, op: "withdraw", amount: 95000 },
    { line: o2, op: "add", amount: 25000 },
  ]);
  const v1 = uuid();
  await drawer("Car", [], [money(v1, "Parking coins", "PLN")], [{ line: v1, op: "add", amount: 6000 }, { line: v1, op: "withdraw", amount: 1200 }]);

  const invite = async (drawerId: string, to: Client, role: "write" | "read") => {
    const boot = (await A.call("GET", "/bootstrap")).json() as { wraps: Array<{ drawer_id: string }> };
    const wrap = boot.wraps.find((w) => w.drawer_id === drawerId);
    const exKey = await A.unwrap(wrap as Parameters<Client["unwrap"]>[0], ania.pub.ecdh, true);
    const r = await A.call("POST", `/drawers/${drawerId}/invitations`, { invitee_id: to.id, role, wrap: await A.wrapFor(exKey, to.user.pub.ecdh, drawerId, 1) });
    if (r.statusCode !== 201) throw new Error(`invite failed: ${r.body}`);
    const acc = await to.call("POST", `/invitations/${r.json().id}/accept`);
    if (acc.statusCode !== 204) throw new Error(`accept failed: ${acc.body}`);
  };
  await invite(bar, B, "write");
  await invite(office, B, "write");
  await invite(kitchen, B, "read");

  await app.close();
  await apiPool.end();
  await maintPool.end();
  process.stdout.write([
    "seed-demo: done.",
    "  ania@petty.local   / password-ania   / vault passphrase: vault ania 2026 drawer   (owns 6 drawers: Kitchen, Bedroom, Shed, Club ×2, Car)",
    "  bartek@petty.local / password-bartek / vault passphrase: vault bartek 2026 drawer (writer on the club drawers, reader on the kitchen)",
    "",
  ].join("\n"));
}

main().catch((err: unknown) => {
  console.error("seed-demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
