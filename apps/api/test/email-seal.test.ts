import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, bgPool, maintPool } from "../src/db.js";
import { sha256 } from "../src/lib/bytes.js";
import { checkEmailKeys, emailKeys, emailMatchParams, emailRateTag, EmailKeyError, linkEmailColumns, openEmail, rewriteEmails, userEmailColumns, type StoredEmail } from "../src/lib/email-seal.js";
import { sentMails } from "../src/lib/mail.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * PETTY-359: stored emails sealed with a server key (EMAIL_KEY). The other test files share this database
 * and run without a key, so everything here touches only its own rows (`only`), and the last test writes
 * them back in plain.
 */
const K1 = Buffer.alloc(32, 7).toString("base64"); // test-only keys
const K2 = Buffer.alloc(32, 9).toString("base64");
const keys = config as { emailKey: string; emailKeysOld: string[] };
const useKeys = (current: string, old: string[] = []) => { keys.emailKey = current; keys.emailKeysOld = old; };

const app = buildApp();
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
const run = crypto.randomUUID().slice(0, 8);
const mine: string[] = []; // every users and join_links row this file made
const row = async (id: string) => (await owner.query<StoredEmail & { email_index: Buffer | null }>("select id, email, email_sealed, email_key_id, email_index from users where id = $1", [id])).rows[0]!;
const linkRow = async (token: string) => (await owner.query<StoredEmail>("select id, email, email_sealed, email_key_id from join_links where token_hash = $1", [sha256(token)])).rows[0];
async function person(name: string): Promise<Client> {
  const c = new Client(app, await userMaterial(name, { email: `${name}-${run}@Test.Local` }));
  const token = await makeJoinLink();
  mine.push((await linkRow(token))!.id);
  expect((await c.signup(token)).statusCode).toBe(201);
  mine.push(c.id);
  return c;
}
const login = (c: Client, email = c.user.email) => c.call("POST", "/auth/login", { email, password: c.user.password });

beforeAll(async () => { await app.ready(); }, 60_000);
afterAll(async () => {
  // back to plain, so a later run of the other files (no key) can read every row
  useKeys("", [K1, K2]);
  await rewriteEmails(apiPool, { only: mine });
  useKeys("");
  await app.close(); await apiPool.end(); await maintPool.end(); await bgPool.end(); await owner.end();
});

describe("the sealing (PETTY-359)", () => {
  const id = crypto.randomUUID();

  it("with no key, a plain row is not counted as sealed with an unknown key", async () => {
    // v1.5.49 counted every plain row as `unknown` here (null <> all('{}') is true) and warned each run
    useKeys("");
    const c = await person("plain");
    expect(await rewriteEmails(apiPool, { only: [c.id] })).toEqual({ users: 0, join_links: 0, unknown: 0, unreadable: 0, conflicts: 0 });
  });

  it("seals an address to its row: it opens there, and nowhere else", async () => {
    useKeys(K1);
    const c = await userEmailColumns(id, "Ann@Example.test");
    expect(c.email).toBeNull();
    expect(c.email_key_id).toMatch(/^[0-9a-f]{16}$/);
    expect(c.email_sealed![0]).toBe(1); // the format
    expect(c.email_sealed!.length).toBe(1 + 12 + "Ann@Example.test".length + 16);
    expect(c.email_sealed!.toString("latin1")).not.toContain("Example");
    expect(c.email_index!.length).toBe(32);
    const stored = { id, email: null, email_sealed: c.email_sealed, email_key_id: c.email_key_id };
    expect(await openEmail("users", stored)).toBe("Ann@Example.test");
    // two seals of one address differ (a new nonce each time); its index does not
    const again = await userEmailColumns(id, "Ann@Example.test");
    expect(again.email_sealed!.equals(c.email_sealed!)).toBe(false);
    expect(again.email_index!.equals(c.email_index!)).toBe(true);
    // bound to its row, its table and its bytes
    expect(await openEmail("users", { ...stored, id: crypto.randomUUID() })).toBeNull();
    expect(await openEmail("join_links", stored)).toBeNull();
    const flipped = Buffer.from(c.email_sealed!);
    flipped.writeUInt8(flipped.readUInt8(20) ^ 1, 20);
    expect(await openEmail("users", { ...stored, email_sealed: flipped })).toBeNull();
  });

  it("another key does not open it, and has another id; EMAIL_KEY_OLD does", async () => {
    useKeys(K1);
    const c = await userEmailColumns(id, "ann@example.test");
    const stored = { id, email: null, email_sealed: c.email_sealed, email_key_id: c.email_key_id };
    useKeys(K2);
    expect((await userEmailColumns(id, "x@example.test")).email_key_id).not.toBe(c.email_key_id);
    expect(await openEmail("users", stored)).toBeNull();
    expect(await openEmail("users", { ...stored, email_key_id: (await emailKeys()).current!.id })).toBeNull(); // the id names the key; a wrong one does not open
    useKeys(K2, [K1]);
    expect(await openEmail("users", stored)).toBe("ann@example.test");
  });

  it("finds an address in any case, under every key it has", async () => {
    useKeys(K1);
    const k1 = (await userEmailColumns(id, "Ann@Example.test")).email_index!;
    const [plain, indexes] = await emailMatchParams("ANN@EXAMPLE.TEST");
    expect(plain).toBe("ANN@EXAMPLE.TEST");
    expect(indexes.map((b) => b.toString("hex"))).toEqual([k1.toString("hex")]);
    useKeys(K2, [K1]);
    expect((await emailMatchParams("ann@example.test"))[1].map((b) => b.toString("hex"))).toContain(k1.toString("hex"));
  });

  it("no key: an address is written plain and a rate key holds it as before; a key turns both into something else", async () => {
    useKeys("");
    expect(await userEmailColumns(id, "Ann@Example.test")).toEqual({ email: "Ann@Example.test", email_sealed: null, email_key_id: null, email_index: null });
    expect(await linkEmailColumns(id, "ann@example.test")).toEqual({ email: "ann@example.test", email_sealed: null, email_key_id: null });
    expect(await linkEmailColumns(id, null)).toEqual({ email: null, email_sealed: null, email_key_id: null });
    expect(await emailRateTag("ann@example.test")).toBe("ann@example.test");
    expect((await emailMatchParams("ann@example.test"))[1]).toEqual([]);
    useKeys(K1);
    const tag = await emailRateTag("ann@example.test");
    expect(tag).not.toContain("ann");
    expect(await emailRateTag("ann@example.test")).toBe(tag);
    expect(tag).not.toBe(`k:${(await userEmailColumns(id, "ann@example.test")).email_index!.toString("base64url")}`); // not the stored index
  });

  it("refuses a key that is not 32 bytes of base64", async () => {
    for (const bad of ["short", Buffer.alloc(16, 1).toString("base64"), Buffer.alloc(33, 1).toString("base64"), "not base64 at all, though long enough to be a key"]) {
      useKeys(bad);
      await expect(emailKeys()).rejects.toBeInstanceOf(EmailKeyError);
    }
    useKeys("", ["nope"]);
    await expect(emailKeys()).rejects.toThrow(/EMAIL_KEY_OLD must be 32 random bytes/);
    useKeys("");
  });
});

describe("the API with an email key (PETTY-359)", () => {
  let ann: Client, ben: Client;

  it("a new account's address is sealed: the row shows no address, and sign-in, /me and lookup still work in any case", async () => {
    useKeys(K1);
    [ann, ben] = [await person("seal-ann"), await person("seal-ben")];
    const r = await row(ann.id);
    expect(r.email).toBeNull();
    expect(r.email_sealed!.toString("latin1").toLowerCase()).not.toContain("seal-ann");
    expect(r.email_index).not.toBeNull();
    expect((await login(ann, ann.user.email.toUpperCase())).statusCode).toBe(200);
    expect((await ann.call("GET", "/me")).json().email).toBe(ann.user.email);
    const found = await ben.call("POST", "/users/lookup", { email: ann.user.email.toLowerCase() });
    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe(ann.id);
    expect((await login(ann, `nobody-${run}@test.local`)).statusCode).toBe(401);
  });

  it("an address cannot sign up twice, in any case", async () => {
    useKeys(K1);
    const twin = new Client(app, await userMaterial("seal-twin", { email: ann.user.email.toLowerCase() }));
    const res = await twin.signup(await makeJoinLink());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("EmailTaken");
  });

  it("a reset mail goes to the address; the rate key holds no address", async () => {
    useKeys(K1);
    expect((await app.inject({ method: "POST", url: "/auth/forgot", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: ann.user.email.toUpperCase() }) })).statusCode).toBe(204);
    const mail = [...sentMails].reverse().find((m) => m.subject.includes("Reset"));
    expect(mail?.to.toLowerCase()).toBe(ann.user.email.toLowerCase());
    const plainKey = sha256(`forgot:${ann.user.email.toLowerCase()}`);
    expect((await owner.query("select 1 from rate_counters where key_hash = $1", [plainKey])).rowCount).toBe(0);
    expect((await owner.query("select 1 from rate_counters where key_hash = $1", [sha256(`forgot:${await emailRateTag(ann.user.email.toLowerCase())}`)])).rowCount).toBe(1);
  });

  it("a join link's address is sealed, shown to its holder, enforced, and forgotten once used", async () => {
    useKeys(K1);
    const friend = `seal-friend-${run}@test.local`;
    const made = await ann.call("POST", "/join-links", { email: friend });
    expect(made.statusCode).toBe(201);
    const token = made.json().token as string;
    const link = (await linkRow(token))!;
    mine.push(link.id);
    expect(link.email).toBeNull();
    expect(link.email_sealed).not.toBeNull();
    expect((await app.inject({ method: "POST", url: "/join-links/lookup", headers: { "content-type": "application/json" }, payload: JSON.stringify({ token }) })).json().email).toBe(friend);
    const other = new Client(app, await userMaterial("seal-other", { email: `seal-other-${run}@test.local` }));
    expect((await other.signup(token)).json().code).toBe("JoinLinkEmailMismatch");
    const ok = new Client(app, await userMaterial("seal-friend", { email: friend.toUpperCase() }));
    expect((await ok.signup(token)).statusCode).toBe(201);
    mine.push(ok.id);
    expect(await linkRow(token)).toMatchObject({ email: null, email_sealed: null, email_key_id: null });
  });

  it("a join link sealed with a key this instance does not have is refused, not taken as one for anyone", async () => {
    useKeys(K2);
    const token = await makeJoinLink(`seal-locked-${run}@test.local`);
    mine.push((await linkRow(token))!.id);
    useKeys("");
    const res = await new Client(app, await userMaterial("seal-locked", { email: `seal-anyone-${run}@test.local` })).signup(token);
    expect(res.statusCode).toBe(503);
    useKeys(K2);
    expect((await linkRow(token))!.email_sealed).not.toBeNull();
  });

  it("a mail to someone whose address this instance cannot open is not sent", async () => {
    useKeys(K1);
    const { id: drawer, res } = await ann.createDrawer("Sealed");
    expect(res.statusCode).toBe(201);
    useKeys("");
    const before = sentMails.length;
    const key = await ann.unwrap((await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawer), ann.user.pub.ecdh, true);
    const inv = await ann.call("POST", `/drawers/${drawer}/invitations`, { invitee_id: ben.id, role: "read", wrap: await ann.wrapFor(key, ben.user.pub.ecdh, drawer, 1) });
    expect(inv.statusCode).toBe(201);
    expect(sentMails.slice(before).filter((m) => m.to === "" || m.to === ben.user.email)).toEqual([]);
  });

  it("a plain address from before the key is still found, and the housekeeping run seals it", async () => {
    useKeys("");
    const old = await person("seal-old");
    expect((await row(old.id)).email).toBe(old.user.email);
    useKeys(K1);
    expect((await login(old)).statusCode).toBe(200);
    expect((await ben.call("POST", "/users/lookup", { email: old.user.email })).json().id).toBe(old.id);
    const twin = new Client(app, await userMaterial("seal-old-twin", { email: old.user.email.toUpperCase() }));
    expect((await twin.signup(await makeJoinLink())).json().code).toBe("EmailTaken");
    const moved = await rewriteEmails(apiPool, { only: mine });
    expect(moved.users).toBeGreaterThanOrEqual(1);
    expect(moved.unknown).toBeGreaterThanOrEqual(1); // the link sealed with K2 above
    expect((await row(old.id)).email).toBeNull();
    expect((await login(old)).statusCode).toBe(200);
    expect((await rewriteEmails(apiPool, { only: mine })).users).toBe(0); // done: a second run finds nothing
  });

  it("a deleted account's placeholder is sealed like any address", async () => {
    useKeys(K1);
    const gone = await person("seal-gone");
    expect((await gone.call("POST", "/me/delete", { password: gone.user.password, proof: await gone.proof(), decisions: [] })).statusCode).toBe(204);
    const r = await row(gone.id);
    expect(r.email).toBeNull();
    expect(await openEmail("users", r)).toBe(`deleted-${gone.id}@deleted.invalid`);
  });

  it("a new key takes over: EMAIL_KEY_OLD still reads, and the run moves every row to the new key", async () => {
    useKeys(K2, [K1]);
    expect((await login(ann)).statusCode).toBe(200);
    const k2 = (await emailKeys()).current!.id;
    await rewriteEmails(apiPool, { only: mine });
    expect((await row(ann.id)).email_key_id).toBe(k2);
    useKeys(K2);
    expect((await login(ann, ann.user.email.toUpperCase())).statusCode).toBe(200);
    expect((await ann.call("GET", "/me")).json().email).toBe(ann.user.email);
  });

  it("start-up refuses a database sealed with a key it does not have, and passes with it", async () => {
    useKeys("");
    await expect(checkEmailKeys(apiPool)).rejects.toThrow(/sealed with a key this instance does not have/);
    useKeys(K1);
    await expect(checkEmailKeys(apiPool)).rejects.toBeInstanceOf(EmailKeyError);
    useKeys(K2, [K1]);
    await expect(checkEmailKeys(apiPool)).resolves.toBeUndefined();
  });

  it("only EMAIL_KEY_OLD: the run writes every address back in plain", async () => {
    useKeys("", [K1, K2]);
    const back = await rewriteEmails(apiPool, { only: mine });
    expect(back.unknown).toBe(0);
    expect(back.users).toBeGreaterThanOrEqual(3);
    expect(await row(ann.id)).toMatchObject({ email: ann.user.email, email_sealed: null, email_key_id: null, email_index: null });
    useKeys("");
    expect((await login(ann)).statusCode).toBe(200);
  });
});
