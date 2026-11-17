import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, bgPool, maintPool } from "../src/db.js";
import { runMaintenance } from "../src/lib/maintenance.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * PETTY-349 (GDPR, storage limitation): deleting an account leaves a tombstone (the users row without email or
 * name, and the public keys) so the records other people keep still verify. Maintenance deletes it once no
 * such record needs it any more, and never before. The rule is in migration 019 (purge_tombstones).
 */
const app = buildApp();
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 3 });
const run = crypto.randomUUID().slice(0, 8);
let n = 0;
let O: Client;

const person = async (name: string) => {
  const c = new Client(app, await userMaterial(`tomb-${name}`, { email: `tomb-${name}-${++n}-${run}@test.local` }));
  expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
  return c;
};
const ownDrawer = async (name: string) => { const { id, res } = await O.createDrawer(name); expect(res.statusCode).toBe(201); return id; };
/** O's drawer key, extractable, so O can wrap it for an invitee. */
const keyOf = async (drawer: string) => O.unwrap((await O.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawer), O.user.pub.ecdh, true);
const deleteAccount = async (c: Client, decisions: unknown[] = []) =>
  expect((await c.call("POST", "/me/delete", { password: c.user.password, proof: await c.proof(), decisions })).statusCode).toBe(204);
/**
 * Other test files run maintenance at the same time. So a tombstone made here is held by an "anchor" (an entry it
 * wrote, in a drawer of O) until the test lets it go with `release`, and no step waits on a tombstone nothing holds.
 */
const anchor = async (id: string) => {
  const drawer = await ownDrawer("Anchor");
  await owner.query("insert into entries (id, drawer_id, line_id, seq, author_id, is_checkpoint, key_version, schema_version, nonce, ciphertext) values (gen_random_uuid(), $1, gen_random_uuid(), 1, $2, false, 1, 1, '\\x00', '\\x00')", [drawer, id]);
  return () => owner.query("select delete_drawer($1)", [drawer]);
};
/** A person who signed up and deleted their account, held only by an anchor. */
const tombstone = async (name: string) => { const c = await person(name); const release = await anchor(c.id); await deleteAccount(c); return { id: c.id, release }; };
const rowOf = async (id: string) => (await owner.query<{ deleted: boolean; keys: number }>(
  "select deleted_at is not null as deleted, (select count(*)::int from user_keys where user_id = u.id) as keys from users u where id = $1", [id],
)).rows[0];
const keysListed = async (id: string) => (await O.call("GET", `/users/${id}/keys`)).statusCode;

beforeAll(async () => { await app.ready(); O = await person("owner"); }, 60_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await bgPool.end(); await owner.end(); });

describe("deleted accounts end once nothing needs them (PETTY-349)", () => {
  it("a tombstone nothing refers to goes, with its keys, its tokens and the rows only about it", async () => {
    const Z = await person("gone");
    // a writing token (its delegation is kept only for entries it signed), an answered invitation, a rotation it ran
    expect((await Z.makeAccessToken("write")).res.statusCode).toBe(201);
    const drawer = await ownDrawer("Hall");
    const inv = await O.call("POST", `/drawers/${drawer}/invitations`, { invitee_id: Z.id, role: "read", wrap: await O.wrapFor(await keyOf(drawer), Z.user.pub.ecdh, drawer, 1) });
    expect(inv.statusCode).toBe(201);
    expect((await Z.call("POST", `/invitations/${inv.json().id}/decline`)).statusCode).toBe(204);
    await owner.query("insert into rotations (drawer_id, to_version, started_by, completed_at) values ($1, 7, $2, now())", [drawer, Z.id]);
    const release = await anchor(Z.id);
    await deleteAccount(Z);
    expect(await rowOf(Z.id)).toEqual({ deleted: true, keys: 1 });
    expect(await keysListed(Z.id)).toBe(200);

    await release();
    const r = await runMaintenance();
    expect(typeof r.tombstones).toBe("number"); // the count is the run's; another file's run may have taken this one first
    expect(await rowOf(Z.id)).toBeUndefined();
    expect(await keysListed(Z.id)).toBe(404);
    for (const [table, col] of [["access_tokens", "user_id"], ["invitations", "invitee_id"], ["rotations", "started_by"], ["join_links", "used_by"]] as const) {
      expect((await owner.query(`select 1 from ${table} where ${col} = $1`, [Z.id])).rowCount, table).toBe(0);
    }
    // the drawer it was invited to is untouched
    expect((await O.call("GET", `/drawers/${drawer}`)).statusCode).toBe(200);
  }, 60_000);

  it("a tombstone stays while an entry it wrote is in a drawer someone keeps, and goes with the drawer", async () => {
    const W = await person("writer");
    const id = await ownDrawer("Pantry");
    const key = await keyOf(id);
    const inv = await O.call("POST", `/drawers/${id}/invitations`, { invitee_id: W.id, role: "write", wrap: await O.wrapFor(key, W.user.pub.ecdh, id, 1) });
    expect((await W.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
    expect((await W.postEntry(id, key, crypto.randomUUID(), "add", 250)).res.statusCode).toBe(201);
    await deleteAccount(W);

    await runMaintenance();
    expect(await rowOf(W.id)).toEqual({ deleted: true, keys: 1 });
    const listed = await O.call("GET", `/users/${W.id}/keys`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ display_name: "Deleted user", deleted: true });

    await owner.query("select delete_drawer($1)", [id]);
    await runMaintenance();
    expect(await rowOf(W.id)).toBeUndefined();
  }, 60_000);

  // Each kind of record that needs a deleted person, made by hand on a tombstone nothing else refers to.
  const refs: Array<[string, (t: string, drawer: string) => Promise<unknown>]> = [
    ["an entry", (t, d) => owner.query("insert into entries (id, drawer_id, line_id, seq, author_id, is_checkpoint, key_version, schema_version, nonce, ciphertext) values (gen_random_uuid(), $1, gen_random_uuid(), 1, $2, false, 1, 1, '\\x00', '\\x00')", [d, t])],
    ["the drawer document", (t, d) => owner.query("update drawer_documents set author_id = $2 where drawer_id = $1", [d, t])],
    ["the drawer photo", (t, d) => owner.query("insert into drawer_photos (drawer_id, author_id, key_version, schema_version, nonce, ciphertext) values ($1, $2, 1, 1, '\\x00', '\\x00')", [d, t])],
    ["a replaced document it wrote", (t, d) => owner.query("insert into drawer_document_history (drawer_id, version, author_id, key_version, schema_version, nonce, ciphertext, written_at) values ($1, 1, $2, 1, 1, '\\x00', '\\x00', now())", [d, t])],
    ["a document it replaced", (t, d) => owner.query("insert into drawer_document_history (drawer_id, version, author_id, key_version, schema_version, nonce, ciphertext, written_at, replaced_by) values ($1, 1, $3, 1, 1, '\\x00', '\\x00', now(), $2)", [d, t, O.id])],
    // PETTY-506: kept photos name their author and who replaced them, like kept documents
    ["a kept photo it took", (t, d) => owner.query("insert into drawer_photo_history (drawer_id, author_id, key_version, schema_version, nonce, ciphertext, written_at) values ($1, $2, 1, 1, '\\x00', '\\x00', now())", [d, t])],
    ["a photo it replaced", (t, d) => owner.query("insert into drawer_photo_history (drawer_id, author_id, key_version, schema_version, nonce, ciphertext, written_at, replaced_by) values ($1, $3, 1, 1, '\\x00', '\\x00', now(), $2)", [d, t, O.id])],
    ["a drawer key it wrapped for a member", (t, d) => owner.query("insert into drawer_keys (drawer_id, user_id, key_version, wrap) values ($1, $3, 2, jsonb_build_object('sender_id', $2::text))", [d, t, O.id])],
    ["a drawer key of its own", (t, d) => owner.query("insert into drawer_keys (drawer_id, user_id, key_version, wrap) values ($1, $2, 2, '{}')", [d, t])],
    ["a membership", (t, d) => owner.query("insert into drawer_members (drawer_id, user_id, role) values ($1, $2, 'read')", [d, t])],
    ["an owned drawer", (t, d) => owner.query("update drawers set owner_id = $2 where id = $1", [d, t])],
    ["an ownership transfer", (t, d) => owner.query("insert into ownership_transfers (drawer_id, from_user_id, to_user_id) values ($1, $3, $2)", [d, t, O.id])],
    ["a pending invitation to it", (t, d) => owner.query("insert into invitations (drawer_id, inviter_id, invitee_id, role, key_version, wrap) values ($1, $3, $2, 'read', 1, '{}')", [d, t, O.id])],
    ["a pending invitation from it", (t, d) => owner.query("insert into invitations (drawer_id, inviter_id, invitee_id, role, key_version, wrap) values ($1, $2, $3, 'read', 1, '{}')", [d, t, O.id])],
  ];
  it.each(refs)("a tombstone stays while %s names it, and goes after", async (_what, make) => {
    const { id: t, release } = await tombstone("ref");
    const drawer = await ownDrawer("Shelf");
    await make(t, drawer);
    await release();
    await runMaintenance();
    expect(await rowOf(t)).toEqual({ deleted: true, keys: 1 });
    await owner.query("select delete_drawer($1)", [drawer]); // every one of these rows belongs to the drawer
    await runMaintenance();
    expect(await rowOf(t)).toBeUndefined();
  }, 60_000);

  it("a live account is never deleted, even with nothing in it", async () => {
    const L = await person("live");
    const r = await runMaintenance();
    expect(typeof r.tombstones).toBe("number");
    expect(await rowOf(L.id)).toEqual({ deleted: false, keys: 1 });
    expect((await L.call("GET", "/me")).statusCode).toBe(200);
  }, 60_000);

  it("a tombstone that a write is naming at that moment is skipped, then kept", async () => {
    const { id: t, release } = await tombstone("race");
    const drawer = await ownDrawer("Porch");
    // an open transaction that inserts a row naming the tombstone holds a key-share lock on its users row
    const tx = await owner.connect();
    try {
      await tx.query("begin");
      await tx.query("insert into drawer_members (drawer_id, user_id, role) values ($1, $2, 'read')", [drawer, t]);
      await release(); // now only the uncommitted row names it
      // the purge does not wait for it and does not delete under it
      await bgPool.query("select purge_tombstones()");
      expect(await rowOf(t)).toEqual({ deleted: true, keys: 1 });
      await tx.query("commit");
    } finally { tx.release(); }
    await runMaintenance();
    expect(await rowOf(t)).toEqual({ deleted: true, keys: 1 }); // the reference committed: kept
    await owner.query("select delete_drawer($1)", [drawer]);
    await runMaintenance();
    expect(await rowOf(t)).toBeUndefined();
  }, 60_000);

  it("the request role cannot delete users or keys itself, only through the function", async () => {
    await expect(bgPool.query("delete from user_keys where false")).rejects.toThrow(/permission denied/);
    await expect(bgPool.query("delete from users where false")).rejects.toThrow(/permission denied/);
  });
});
