import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, fromB64, hkdfAesKey, open, seal, toB64, utf8, fromUtf8, type RecordIdentity } from "@petty/crypto";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, bgPool, maintPool } from "../src/db.js";
import { KEPT_NEWEST } from "../src/lib/kept.js";
import { runMaintenance } from "../src/lib/maintenance.js";
import { Client, makeJoinLink, userMaterial } from "../src/devtools/fixtures.js";

/**
 * PETTY-506: a replaced user document, and a replaced or removed drawer photo, stay 30 days, so the person's own
 * app can put one back after a bad write (a stolen session without the vault key, a bug, a bad sync).
 */
const app = buildApp();
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });
const run = crypto.randomUUID().slice(0, 8);
let n = 0;
const person = async (name: string) => {
  const c = new Client(app, await userMaterial(`kept-${name}`, { email: `kept-${name}-${++n}-${run}@test.local` }));
  expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
  return c;
};
const fake = (bytes: number, fill: number) => Buffer.alloc(bytes, fill).toString("base64"); // the server never opens a photo
const photo = (bytes: number, fill: number) => ({ key_version: 1, schema_version: 1, nonce: fake(12, fill), ciphertext: fake(bytes, fill) });
const setQuota = (bytes: number | null) => { (config as { storageQuotaBytes: number | null }).storageQuotaBytes = bytes; };
const asToken = (bearer: string) => (method: "GET", url: string) => app.inject({ method, url, headers: { authorization: `Bearer ${bearer}` } });

/** A person's user-document key, as the web app derives it (apps/web/src/lib/pins.ts). */
async function userDocKey(c: Client): Promise<{ key: CryptoKey; identity: RecordIdentity }> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: c.user.keys.ecdh.publicKey }, c.user.keys.ecdh.privateKey, 256));
  const key = await hkdfAesKey(shared, utf8("petty/self-doc/v1"), utf8(c.id), "AES-GCM", ["encrypt", "decrypt"]);
  return { key, identity: { record_type: "document", record_id: c.id, drawer_id: c.id, line_id: null, author_id: c.id, key_version: 1, schema_version: 1 } };
}
interface Kept { id: string; replaced_at: string; document: { version: number; nonce: string; ciphertext: string } }
const history = async (c: Client) => (await c.call("GET", "/me/doc/history")).json().history as Kept[];

beforeAll(async () => { await app.ready(); }, 60_000);
afterEach(() => setQuota(null));
afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await bgPool.end(); await owner.end(); });

describe("kept user documents (PETTY-506)", () => {
  it("each save keeps the copy it replaced; the person's app opens it, and saving it again puts it back", async () => {
    const A = await person("doc");
    expect((await A.call("GET", "/me/doc/history")).json()).toEqual({ history: [] });
    await A.editUserDoc((d) => { d.places = [{ name: "Kitchen", children: [] }]; });
    await A.editUserDoc((d) => { d.places = [{ name: "Garage", children: [] }]; });
    await A.editUserDoc((d) => { d.places = [{ name: "Attic", children: [] }]; });
    const kept = await history(A);
    expect(kept.map((k) => k.document.version)).toEqual([2, 1]); // newest first; version 3 is the current one
    const { key, identity } = await userDocKey(A);
    const opened = JSON.parse(fromUtf8(await open(key, identity, { nonce: fromB64(kept[0]!.document.nonce), ciphertext: fromB64(kept[0]!.document.ciphertext) })));
    expect(opened).toMatchObject({ v: 2, rev: 2, places: [{ name: "Garage" }] });

    // a write that does not open (a session without the vault key can make one) keeps the good copy
    const bad = await A.call("PUT", "/me/doc", { base_version: 3, schema_version: 1, nonce: fake(12, 1), ciphertext: fake(2048, 2) });
    expect(bad.statusCode).toBe(200);
    await expect(A.readUserDoc()).rejects.toThrow();
    const after = await history(A);
    expect(after.map((k) => k.document.version)).toEqual([3, 2, 1]);
    // the app puts the newest good copy back as a normal save, with a counter above every one it saw
    const good = JSON.parse(fromUtf8(await open(key, identity, { nonce: fromB64(after[0]!.document.nonce), ciphertext: fromB64(after[0]!.document.ciphertext) })));
    const sealed = await seal(key, identity, utf8(canonicalJson({ ...good, rev: good.rev + 1 })));
    expect((await A.call("PUT", "/me/doc", { base_version: 4, schema_version: 1, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) })).statusCode).toBe(200);
    expect((await A.readUserDoc())!.doc).toMatchObject({ rev: 4, places: [{ name: "Attic" }] });
    expect((await history(A)).length).toBe(4); // the unreadable one is kept too: the server cannot tell
  });

  it("only the person's own session lists them: a token is refused", async () => {
    const A = await person("tok");
    await A.editUserDoc();
    await A.editUserDoc();
    const t = await A.makeAccessToken("write");
    expect(t.res.statusCode).toBe(201);
    const res = await asToken(t.bearer)("GET", "/me/doc/history");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TokenNotAllowed");
  });

  it(`many saves in a row keep the ${KEPT_NEWEST} newest and the first of the day, so a burst cannot push out the state before it`, async () => {
    const A = await person("burst");
    for (let i = 0; i < KEPT_NEWEST + 6; i++) await A.editUserDoc((d) => { d.line_tags = [`t${i}`]; });
    const versions = (await history(A)).map((k) => k.document.version);
    const current = KEPT_NEWEST + 6;
    expect(versions.slice(0, KEPT_NEWEST)).toEqual(Array.from({ length: KEPT_NEWEST }, (_, i) => current - 1 - i));
    expect(versions).toContain(1); // the first copy replaced today
    expect(versions.length).toBeLessThanOrEqual(KEPT_NEWEST + 2); // + one more first-of-day if the run crossed midnight
  });

  it("a copy older than 30 days is not listed, and housekeeping deletes it; deleting the account deletes them all", async () => {
    const A = await person("old");
    await A.editUserDoc();
    await A.editUserDoc();
    await A.editUserDoc();
    const [newest, oldest] = await history(A);
    await owner.query("update user_doc_history set replaced_at = now() - interval '31 days' where id = $1", [oldest!.id]);
    expect((await history(A)).map((k) => k.id)).toEqual([newest!.id]);
    expect((await runMaintenance()).kept_copies).toBeGreaterThanOrEqual(1);
    expect((await owner.query("select id from user_doc_history where user_id = $1", [A.id])).rows.map((r) => String(r.id))).toEqual([newest!.id]);

    expect((await A.call("POST", "/me/delete", { password: A.user.password, proof: await A.proof(), decisions: [] })).statusCode).toBe(204);
    expect((await owner.query("select 1 from user_doc_history where user_id = $1", [A.id])).rowCount).toBe(0);
  });
});

describe("kept drawer photos (PETTY-506)", () => {
  /** A drawer of `A` with `B` as a writing member. */
  async function shared(A: Client, B: Client) {
    const { id, res } = await A.createDrawer("Shelf");
    expect(res.statusCode).toBe(201);
    const exKey = await A.unwrap((await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), A.user.pub.ecdh, true);
    const inv = await A.call("POST", `/drawers/${id}/invitations`, { invitee_id: B.id, role: "write", wrap: await A.wrapFor(exKey, B.user.pub.ecdh, id, 1) });
    expect(inv.statusCode).toBe(201);
    expect((await B.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
    return id;
  }

  it("a replaced or removed photo is kept; only the owner lists and fetches it, sealed as it was", async () => {
    const [A, B] = [await person("ph-owner"), await person("ph-member")];
    const id = await shared(A, B);
    expect((await A.call("PUT", `/drawers/${id}/photo`, photo(20_000, 1))).statusCode).toBe(204);
    expect((await B.call("PUT", `/drawers/${id}/photo`, photo(30_000, 2))).statusCode).toBe(204); // replaces A's
    expect((await B.call("DELETE", `/drawers/${id}/photo`)).statusCode).toBe(204);              // removes B's
    expect((await A.call("GET", `/drawers/${id}/photo`)).statusCode).toBe(404);

    const list = (await A.call("GET", `/drawers/${id}/photo/history`)).json().history as { id: string; author_id: string; replaced_by: string; removed: boolean; key_version: number }[];
    expect(list.map((h) => ({ author: h.author_id, by: h.replaced_by, removed: h.removed, kv: h.key_version }))).toEqual([
      { author: B.id, by: B.id, removed: true, kv: 1 },
      { author: A.id, by: B.id, removed: false, kv: 1 },
    ]);
    const first = (await A.call("GET", `/drawers/${id}/photo/history/${list[1]!.id}`)).json();
    expect(first).toMatchObject({ author_id: A.id, key_version: 1, schema_version: 1, nonce: fake(12, 1), ciphertext: fake(20_000, 1) });

    // the writing member cannot list or fetch them, and neither can a token
    expect((await B.call("GET", `/drawers/${id}/photo/history`)).statusCode).toBe(403);
    expect((await B.call("GET", `/drawers/${id}/photo/history/${list[1]!.id}`)).statusCode).toBe(403);
    const stranger = await person("ph-stranger");
    expect((await stranger.call("GET", `/drawers/${id}/photo/history`)).statusCode).toBe(404);
    expect((await stranger.call("GET", `/drawers/${id}/photo/history/${list[1]!.id}`)).statusCode).toBe(404);
    const t = await A.makeAccessToken("read", [], [id]);
    expect((await asToken(t.bearer)("GET", `/drawers/${id}/photo/history`)).json().code).toBe("TokenNotAllowed");
    // an id of another drawer, or no number, is not found
    const other = (await A.createDrawer("Other")).id;
    expect((await A.call("GET", `/drawers/${other}/photo/history/${list[1]!.id}`)).statusCode).toBe(404);
    expect((await A.call("GET", `/drawers/${id}/photo/history/x1`)).statusCode).toBe(404);

    // putting it back is a normal photo write; deleting the drawer deletes every kept copy
    expect((await A.call("PUT", `/drawers/${id}/photo`, photo(20_000, 3))).statusCode).toBe(204);
    expect((await A.call("DELETE", `/drawers/${id}`, { proof: await A.proof() })).statusCode).toBe(204);
    expect((await owner.query("select 1 from drawer_photo_history where drawer_id = $1", [id])).rowCount).toBe(0);
  });

  it("kept photos count against the owner's storage: a new photo adds its whole size", async () => {
    const A = await person("ph-quota");
    const { id } = await A.createDrawer("Box");
    expect((await A.call("PUT", `/drawers/${id}/photo`, photo(100_000, 1))).statusCode).toBe(204);
    const used = (await A.call("GET", "/me/storage")).json().used_bytes as number;
    setQuota(used + 150_000);
    const over = await A.call("PUT", `/drawers/${id}/photo`, photo(160_000, 2));
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({ code: "StorageQuotaExceeded", context: { used_bytes: used } });
    expect((await A.call("PUT", `/drawers/${id}/photo`, photo(140_000, 3))).statusCode).toBe(204);
    expect((await A.call("GET", "/me/storage")).json().used_bytes).toBe(used + 140_000); // the 100 000 are still kept
    // removing it is always allowed; its bytes stay counted until the copy ends
    setQuota(used + 140_000);
    expect((await A.call("DELETE", `/drawers/${id}/photo`)).statusCode).toBe(204);
    expect((await A.call("GET", "/me/storage")).json().used_bytes).toBe(used + 140_000);
  });
});
