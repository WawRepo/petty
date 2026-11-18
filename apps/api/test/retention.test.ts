import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { patSecret, sealPatBundle, toB64 } from "@petty/crypto";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, bgPool, maintPool } from "../src/db.js";
import { sha256 } from "../src/lib/bytes.js";
import { runMaintenanceAlone } from "./maintenance-alone.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * PETTY-341 (GDPR, storage limitation): what the server keeps about people only as long as it is needed.
 * A join link's email belongs to someone who may never sign up; a reset token is dead after its hour.
 */
const app = buildApp();
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
const run = crypto.randomUUID().slice(0, 8);
const emailOf = async (token: string) => (await owner.query<{ email: string | null }>("select email from join_links where token_hash = $1", [sha256(token)])).rows[0];

beforeAll(async () => { await app.ready(); }, 60_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await bgPool.end(); await owner.end(); });

describe("personal data is not kept longer than needed (PETTY-341)", () => {
  it("a used join link forgets its email; maintenance deletes ended unused links and dead reset tokens", async () => {
    const used = await makeJoinLink(`used-${run}@test.local`);
    const u = new Client(app, await userMaterial("ret-used", { email: `used-${run}@test.local` }));
    expect((await u.signup(used)).statusCode).toBe(201);
    expect(await emailOf(used)).toEqual({ email: null });

    const ended = await makeJoinLink(`ended-${run}@test.local`);
    await owner.query("update join_links set expires_at = now() - interval '1 minute' where token_hash = $1", [sha256(ended)]);
    const open = await makeJoinLink(`open-${run}@test.local`);
    await owner.query("insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, now() - interval '1 minute'), ($1, $3, now() + interval '1 hour')", [u.id, sha256(`dead-${run}`), sha256(`live-${run}`)]);

    await runMaintenanceAlone();
    expect(await emailOf(ended)).toBeUndefined();
    expect(await emailOf(open)).toEqual({ email: `open-${run}@test.local` }); // still usable, so still kept
    expect(await emailOf(used)).toEqual({ email: null }); // the row stays: who joined through whom
    const resets = (await owner.query<{ token_hash: Buffer }>("select token_hash from password_resets where user_id = $1", [u.id])).rows.map((r) => r.token_hash.toString("hex"));
    expect(resets).toEqual([sha256(`live-${run}`).toString("hex")]);
  });

  it("deleting an account deletes its unused invites (with the invitee's email) and its reset tokens", async () => {
    const d = new Client(app, await userMaterial("ret-del", { email: `del-${run}@test.local` }));
    expect((await d.signup(await makeJoinLink())).statusCode).toBe(201);
    expect((await d.call("POST", "/join-links", { email: `friend-${run}@test.local` })).statusCode).toBe(201);
    expect((await d.call("POST", "/auth/forgot", { email: `del-${run}@test.local` })).statusCode).toBeLessThan(300);
    expect((await owner.query("select 1 from join_links where created_by = $1", [d.id])).rowCount).toBe(1);
    expect((await owner.query("select 1 from password_resets where user_id = $1", [d.id])).rowCount).toBe(1);

    expect((await d.call("POST", "/me/delete", { password: d.user.password, proof: await d.proof(), decisions: [] })).statusCode).toBe(204);
    expect((await owner.query("select 1 from join_links where created_by = $1", [d.id])).rowCount).toBe(0);
    expect((await owner.query("select 1 from join_links where email = $1", [`friend-${run}@test.local`])).rowCount).toBe(0);
    expect((await owner.query("select 1 from password_resets where user_id = $1", [d.id])).rowCount).toBe(0);
  });

  it("maintenance drops what an expired or revoked token stored: its sealed bundle and its drawer-key wraps (PETTY-410)", async () => {
    const u = new Client(app, await userMaterial("ret-tok", { email: `tok-${run}@test.local` }));
    expect((await u.signup(await makeJoinLink())).statusCode).toBe(201);
    const { id: drawerId, res } = await u.createDrawer("Shed");
    expect(res.statusCode).toBe(201);
    const key = await u.unwrap((await u.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId), u.user.pub.ecdh, true);
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
    const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    const make = async (name: string) => {
      const tokenId = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
      const made = await u.call("POST", "/me/tokens", {
        token_id: tokenId, ecdh_pub: pub, name, role: "read", scope: null, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        bundle: await sealPatBundle(patSecret(), tokenId, { v: 1, user_id: u.id, drawers: [] }), proof: await u.proof(),
      });
      expect(made.statusCode).toBe(201);
      const id = made.json().id as string;
      expect((await u.call("POST", `/me/tokens/${id}/keys`, { keys: [{ drawer_id: drawerId, key_version: 1, wrap: await u.wrapFor(key, pub, drawerId, 1) }] })).statusCode).toBe(204);
      return id;
    };
    const stored = async (id: string) => (await owner.query<{ bundle: boolean; keys: number }>(
      "select bundle_ciphertext <> '' as bundle, (select count(*)::int from access_token_keys k where k.token_id = t.id) as keys from access_tokens t where id = $1", [id],
    )).rows[0];

    // all three are made first: making a token drops its owner's dead ones (PETTY-442), and this is about an owner who makes no more
    const [expired, revokedEarly, live] = [await make("expired"), await make("revoked before PETTY-442"), await make("live")];
    await owner.query("update access_tokens set expires_at = now() - interval '1 minute' where id = $1", [expired]);
    await owner.query("update access_tokens set revoked_at = now() where id = $1", [revokedEarly]); // what a revoke before PETTY-442 left behind

    await runMaintenanceAlone();
    expect(await stored(expired)).toEqual({ bundle: false, keys: 0 });
    expect(await stored(revokedEarly)).toEqual({ bundle: false, keys: 0 });
    expect(await stored(live)).toEqual({ bundle: true, keys: 1 }); // a live token keeps what it needs
    // the rows stay: the token list shows them, and a writing token's delegation still verifies what it signed
    expect((await owner.query("select 1 from access_tokens where id = any($1)", [[expired, revokedEarly]])).rowCount).toBe(2);
  });

  it("maintenance drops drawer documents replaced more than 30 days ago, also in a drawer nobody writes to again (PETTY-488)", async () => {
    const u = new Client(app, await userMaterial("ret-hist", { email: `hist-${run}@test.local` }));
    expect((await u.signup(await makeJoinLink())).statusCode).toBe(201);
    const { id: drawerId, res } = await u.createDrawer("Attic");
    expect(res.statusCode).toBe(201);
    // two kept copies of the current document, as two writes would leave them: one 31 days old, one a day old
    const keep = (days: number) => owner.query(
      `insert into drawer_document_history (drawer_id, version, author_id, key_version, schema_version, nonce, ciphertext, written_at, replaced_by, replaced_at)
       select drawer_id, 1, author_id, key_version, schema_version, nonce, ciphertext, updated_at, author_id, now() - make_interval(days => $2) from drawer_documents where drawer_id = $1`,
      [drawerId, days],
    );
    await keep(31);
    await keep(1);
    const old = async () => (await owner.query<{ n: number }>("select count(*)::int as n from drawer_document_history where drawer_id = $1 and replaced_at < now() - interval '30 days'", [drawerId])).rows[0]!.n;
    const all = async () => (await owner.query<{ n: number }>("select count(*)::int as n from drawer_document_history where drawer_id = $1", [drawerId])).rows[0]!.n;
    expect([await old(), await all()]).toEqual([1, 2]);

    const r = await runMaintenanceAlone();
    expect(typeof r.document_history).toBe("number"); // the run's count: another file's run may have taken this copy first (PETTY-532)
    expect([await old(), await all()]).toEqual([0, 1]); // the day-old copy stays restorable
  });
});
