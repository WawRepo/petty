import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * PETTY-493: the seeds (`make seed`, `make demo`) give each account the user document the web app keeps:
 * started before a first drawer, and with the confirmed keys of the person on the other side of each
 * invitation. Without one, an account with drawers opens to the warning that the server has no list of
 * trusted keys.
 */
const app = buildApp();
const run = crypto.randomUUID().slice(0, 8);
let A: Client, B: Client;

beforeAll(async () => {
  await app.ready();
  const mk = async (n: string) => new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }));
  [A, B] = await Promise.all([mk("seed-a"), mk("seed-b")]);
  for (const c of [A, B]) expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); });

describe("the seeds' user documents (PETTY-493)", () => {
  it("starts an empty one, then adds a confirmed person with the counter one up each time", async () => {
    expect(await A.readUserDoc()).toBeNull();
    expect(await A.editUserDoc()).toBe(1);
    expect(await A.readUserDoc()).toEqual({ version: 1, doc: { v: 2, rev: 1, pins: {} } });
    await A.confirm(B);
    const after = await A.readUserDoc();
    expect(after?.version).toBe(2);
    expect(after?.doc.rev).toBe(2);
    expect(after?.doc.pins[B.id]).toMatchObject({ ecdh: B.user.pub.ecdh, ecdsa: B.user.pub.ecdsa, sig_key_id: B.user.sig_key_id });
    expect(after?.doc.pins[B.id]?.confirmed_at).toEqual(after?.doc.pins[B.id]?.pinned_at);
  });

  it("is sealed to its owner: another person's keys do not open it", async () => {
    await B.confirm(A);
    expect((await B.readUserDoc())?.doc.pins[A.id]?.confirmed_at).toBeTruthy();
    // B's row, read in B's session, with A's keys: the key is derived from B's own keys, so it does not open
    const withOtherKeys = new Client(app, A.user, B.id);
    withOtherKeys.cookie = B.cookie;
    await expect(withOtherKeys.readUserDoc()).rejects.toThrow();
  });
});
