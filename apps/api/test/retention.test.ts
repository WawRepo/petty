import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, maintPool } from "../src/db.js";
import { sha256 } from "../src/lib/bytes.js";
import { runMaintenance } from "../src/lib/maintenance.js";
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
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

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

    await runMaintenance();
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
});
