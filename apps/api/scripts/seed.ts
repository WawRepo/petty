/**
 * Dev seed, driven through the real API with real ciphertext:
 *   alice, bob, carol (login password `password-<name>`, vault passphrase `vault <name> 2026 drawer`)
 *   alice owns "Kitchen" (PLN line with entries, a countable, a passport); bob = write, carol = read.
 * Skips if alice already exists; use `make reset` to start over.
 */
import pg from "pg";
import { hashEntry } from "@petty/crypto";
import { applyOps, newDocument } from "@petty/ledger";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial, sealedBody } from "../src/devtools/fixtures.js";

async function main() {
  const owner = new pg.Client({ connectionString: config.ownerDatabaseUrl });
  await owner.connect();
  const exists = await owner.query("select 1 from users where email = 'alice@petty.local'");
  await owner.end();
  if (exists.rowCount) { process.stdout.write("seed: alice already exists — run `make reset` to reseed\n"); return; }

  const app = buildApp();
  await app.ready();
  const [alice, bob, carol] = await Promise.all([userMaterial("alice"), userMaterial("bob"), userMaterial("carol")]);
  const A = new Client(app, alice), B = new Client(app, bob), C = new Client(app, carol);
  for (const c of [A, B, C]) {
    const r = await c.signup(await makeJoinLink());
    if (r.statusCode !== 201) throw new Error(`signup failed: ${r.body}`);
  }

  const pln = crypto.randomUUID(), balls = crypto.randomUUID(), passport = crypto.randomUUID();
  const doc = applyOps(newDocument("Kitchen"), [
    { type: "add_line", line: { id: pln, kind: "money", name: "PLN kitchen", currency: "PLN", exponent: 2 } },
    { type: "add_line", line: { id: balls, kind: "countable", name: "Glass balls", unit: "balls" } },
    { type: "add_line", line: { id: passport, kind: "single", name: "Passport", text: "expires 2031" } },
  ], { lineHasEntries: () => false });
  const { id: drawerId, key, res } = await A.createDrawer("Kitchen", doc);
  if (res.statusCode !== 201) throw new Error(`drawer failed: ${res.body}`);

  const e1 = await A.postEntry(drawerId, key, pln, "add", 10000);
  const e2 = await A.postEntry(drawerId, key, pln, "withdraw", -2550, { prev_hash: await hashEntry(e1.signed) });
  const e3 = await A.postEntry(drawerId, key, pln, "adjust", 7450, { prev_hash: await hashEntry(e2.signed), expected_head_seq: 2, delta_hint: 0 });
  await A.postEntry(drawerId, key, balls, "add", 56);
  for (const r of [e1, e2, e3]) if (r.res.statusCode !== 201) throw new Error(`entry failed: ${r.res.body}`);

  const invite = async (to: Client, role: "write" | "read") => {
    const wrap = await A.wrapFor(await A.unwrap((await A.call("GET", "/bootstrap")).json().wraps[0], alice.pub.ecdh, true), to.user.pub.ecdh, drawerId, 1);
    const r = await A.call("POST", `/drawers/${drawerId}/invitations`, { invitee_id: to.id, role, wrap });
    if (r.statusCode !== 201) throw new Error(`invite failed: ${r.body}`);
    const acc = await to.call("POST", `/invitations/${r.json().id}/accept`);
    if (acc.statusCode !== 204) throw new Error(`accept failed: ${acc.body}`);
  };
  await invite(B, "write");
  await invite(C, "read");
  void sealedBody;

  await app.close();
  await apiPool.end();
  await maintPool.end();
  process.stdout.write(`seeded: alice, bob, carol; drawer ${drawerId} (Kitchen) shared with bob (write) and carol (read)\n`);
}

main().catch((err: unknown) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
