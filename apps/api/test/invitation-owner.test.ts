import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * Invitations belong to the drawer's owner (PETTY-446). Only the owner invites, so a pending invitation
 * ends when the drawer changes hands, and the owner of the day can list and revoke every pending one.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
let A: Client, B: Client, C: Client, D: Client;

beforeAll(async () => {
  await app.ready();
  const mk = async (n: string) => new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }));
  [A, B, C, D] = await Promise.all([mk("inv-a"), mk("inv-b"), mk("inv-c"), mk("inv-d")]);
  for (const c of [A, B, C, D]) expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

/** A drawer of `o` with `member` as a write member. Returns the id and a function that invites at key version 1. */
async function sharedDrawer(o: Client, member: Client) {
  const { id, res } = await o.createDrawer("Shared");
  expect(res.statusCode).toBe(201);
  const key = await o.unwrap((await o.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), o.user.pub.ecdh, true);
  // the drawer key is the same for every inviter: whoever owns the drawer wraps it for the invitee
  const invite = async (from: Client, to: Client, role: "write" | "read" = "write") => from.call("POST", `/drawers/${id}/invitations`, { invitee_id: to.id, role, wrap: await from.wrapFor(key, to.user.pub.ecdh, id, 1) });
  const first = await invite(o, member);
  expect(first.statusCode).toBe(201);
  expect((await member.call("POST", `/invitations/${first.json().id}/accept`)).statusCode).toBe(204);
  return { id, invite };
}
const handOver = async (id: string, from: Client, to: Client) => {
  expect((await from.call("POST", `/drawers/${id}/transfer`, { to_user_id: to.id })).statusCode).toBe(201);
  expect((await to.call("POST", `/drawers/${id}/transfer/accept`)).statusCode).toBe(204);
  expect((await to.call("GET", `/drawers/${id}`)).json().drawer.role).toBe("owner");
};
const pendingFor = async (c: Client) => ((await c.call("GET", "/invitations")).json().invitations as Array<{ id: string }>).map((i) => i.id);
const stateOf = async (invitationId: string) => (await owner.query<{ state: string }>("select state from invitations where id = $1", [invitationId])).rows[0]?.state;

describe("invitations and the drawer's owner (PETTY-446)", () => {
  it("a pending invitation ends when the drawer changes hands; the new owner invites anew", async () => {
    const { id, invite } = await sharedDrawer(A, B);
    const inv = await invite(A, C);
    expect(inv.statusCode).toBe(201);
    expect(await pendingFor(C)).toContain(inv.json().id);
    await handOver(id, A, B);
    // the invitation is over: not listed, not accepted, no membership
    expect(await stateOf(inv.json().id)).toBe("revoked");
    expect(await pendingFor(C)).not.toContain(inv.json().id);
    const accept = await C.call("POST", `/invitations/${inv.json().id}/accept`);
    expect(accept.statusCode).toBe(404);
    expect(accept.json().code).toBe("InvitationNotFound");
    expect((await C.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
    expect((await C.call("GET", "/bootstrap")).json().wraps.some((w: { drawer_id: string }) => w.drawer_id === id)).toBe(false);
    // the owner of the day decides again
    const again = await invite(B, C, "read");
    expect(again.statusCode).toBe(201);
    expect((await C.call("POST", `/invitations/${again.json().id}/accept`)).statusCode).toBe(204);
    expect((await C.call("GET", `/drawers/${id}`)).json().drawer.role).toBe("read");
  }, 60_000);

  it("the owner lists the drawer's pending invitations; a member and a stranger do not", async () => {
    const { id, invite } = await sharedDrawer(A, B);
    expect((await A.call("GET", `/drawers/${id}/invitations`)).json()).toEqual({ invitations: [] });
    const invC = await invite(A, C, "read");
    const invD = await invite(A, D);
    const list = await A.call("GET", `/drawers/${id}/invitations`);
    expect(list.statusCode).toBe(200);
    expect(list.json().invitations).toEqual([
      { id: invC.json().id, drawer_id: id, role: "read", key_version: 1, created_at: invC.json().created_at, inviter_id: A.id, invitee: { id: C.id, display_name: C.user.display_name } },
      { id: invD.json().id, drawer_id: id, role: "write", key_version: 1, created_at: invD.json().created_at, inviter_id: A.id, invitee: { id: D.id, display_name: D.user.display_name } },
    ]);
    // an answered or revoked invitation is no longer pending
    expect((await D.call("POST", `/invitations/${invD.json().id}/decline`)).statusCode).toBe(204);
    expect((await A.call("GET", `/drawers/${id}/invitations`)).json().invitations.map((i: { id: string }) => i.id)).toEqual([invC.json().id]);
    const member = await B.call("GET", `/drawers/${id}/invitations`);
    expect(member.statusCode).toBe(403);
    expect(member.json().code).toBe("InsufficientRole");
    expect((await D.call("GET", `/drawers/${id}/invitations`)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/drawers/${id}/invitations` })).statusCode).toBe(401);
  }, 60_000);

  it("an invitation whose inviter no longer owns the drawer cannot be accepted, and the owner sees and revokes it", async () => {
    const { id } = await sharedDrawer(A, B);
    await handOver(id, A, B);
    // a row as an earlier release left it: pending, made by the former owner
    const wrap = (await owner.query<{ wrap: unknown }>("select wrap from drawer_keys where drawer_id = $1 and user_id = $2", [id, A.id])).rows[0]!.wrap;
    const left = (await owner.query<{ id: string }>("insert into invitations (drawer_id, inviter_id, invitee_id, role, key_version, wrap) values ($1, $2, $3, 'write', 1, $4) returning id", [id, A.id, C.id, JSON.stringify(wrap)])).rows[0]!.id;
    const accept = await C.call("POST", `/invitations/${left}/accept`);
    expect(accept.statusCode).toBe(404);
    expect(accept.json().code).toBe("InvitationNotFound");
    expect((await C.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
    // the owner of the day sees it and ends it; the former owner, now a member, cannot
    expect((await B.call("GET", `/drawers/${id}/invitations`)).json().invitations.map((i: { id: string; inviter_id: string }) => [i.id, i.inviter_id])).toEqual([[left, A.id]]);
    expect((await A.call("DELETE", `/invitations/${left}`)).statusCode).toBe(404);
    expect((await D.call("DELETE", `/invitations/${left}`)).statusCode).toBe(404);
    expect(await stateOf(left)).toBe("pending");
    expect((await B.call("DELETE", `/invitations/${left}`)).statusCode).toBe(204);
    expect(await stateOf(left)).toBe("revoked");
    expect((await B.call("DELETE", `/invitations/${left}`)).statusCode).toBe(404); // once
  }, 60_000);

  it("a drawer handed over when its owner deletes the account keeps no pending invitation", async () => {
    const leaving = new Client(app, await userMaterial("inv-e", { email: `inv-e-${run}@test.local` }));
    expect((await leaving.signup(await makeJoinLink())).statusCode).toBe(201);
    const { id, invite } = await sharedDrawer(leaving, B);
    const own = await invite(leaving, C);
    expect(own.statusCode).toBe(201);
    // and one that an earlier owner left behind
    const wrap = (await owner.query<{ wrap: unknown }>("select wrap from drawer_keys where drawer_id = $1 and user_id = $2", [id, leaving.id])).rows[0]!.wrap;
    const left = (await owner.query<{ id: string }>("insert into invitations (drawer_id, inviter_id, invitee_id, role, key_version, wrap) values ($1, $2, $3, 'read', 1, $4) returning id", [id, A.id, D.id, JSON.stringify(wrap)])).rows[0]!.id;
    const gone = await leaving.call("POST", "/me/delete", { password: leaving.user.password, proof: await leaving.proof(), decisions: [{ drawer_id: id, action: "transfer", to_user_id: B.id }] });
    expect(gone.statusCode).toBe(204);
    expect((await B.call("GET", `/drawers/${id}`)).json().drawer.role).toBe("owner");
    expect(await stateOf(own.json().id)).toBe("revoked");
    expect(await stateOf(left)).toBe("revoked");
    expect((await B.call("GET", `/drawers/${id}/invitations`)).json()).toEqual({ invitations: [] });
  }, 60_000);
});
