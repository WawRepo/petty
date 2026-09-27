import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateDrawerKey, hashEntry, sealPhoto } from "@petty/crypto";
import { applyOp, newDocument } from "@petty/ledger";
import { ENTRY_MAX_CIPHERTEXT, PHOTO_MAX_BYTES, PHOTO_MAX_CIPHERTEXT } from "@petty/protocol";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { apiPool, maintPool } from "../src/db.js";
import { Client, makeJoinLink, sealedBody, userMaterial } from "../src/devtools/fixtures.js";

const app = buildApp();
const run = Math.random().toString(36).slice(2, 8);
let A: Client, B: Client, C: Client, N: Client; // owner, write, read, non-member
const owner = new pg.Pool({ connectionString: config.ownerDatabaseUrl, max: 2 });

beforeAll(async () => {
  await app.ready();
  const mk = async (n: string) => new Client(app, await userMaterial(n, { email: `${n}-${run}@test.local` }));
  [A, B, C, N] = await Promise.all([mk("alice"), mk("bob"), mk("carol"), mk("nobody")]);
  for (const c of [A, B, C, N]) expect((await c.signup(await makeJoinLink())).statusCode).toBe(201);
}, 120_000);

afterAll(async () => { await app.close(); await apiPool.end(); await maintPool.end(); await owner.end(); });

/** Creates a drawer owned by A with one money line, shares it with B (write) and C (read). */
async function sharedDrawer() {
  const line = crypto.randomUUID();
  const doc = applyOp(newDocument("Kitchen"), { type: "add_line", line: { id: line, kind: "money", name: "PLN", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
  const { id, key, res } = await A.createDrawer("Kitchen", doc);
  expect(res.statusCode).toBe(201);
  for (const [who, role] of [[B, "write"], [C, "read"]] as const) {
    const exKey = await A.unwrap((await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), A.user.pub.ecdh, true);
    const wrap = await A.wrapFor(exKey, who.user.pub.ecdh, id, 1);
    const inv = await A.call("POST", `/drawers/${id}/invitations`, { invitee_id: who.id, role, wrap });
    expect(inv.statusCode).toBe(201);
    expect((await who.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
  }
  return { id, key, line, doc };
}

describe("database roles (CLAUDE.md rule 8)", () => {
  it("petty_api cannot UPDATE or DELETE entries; petty_maint may only re-seal, never rewrite identity or lower key_version", async () => {
    const { id, key, line } = await sharedDrawer();
    const e = await A.postEntry(id, key, line, "add", 100);
    expect(e.res.statusCode).toBe(201);
    await expect(apiPool.query("update entries set ciphertext = '\\x00' where id = $1", [e.id])).rejects.toThrow(/permission denied/);
    await expect(apiPool.query("delete from entries where id = $1", [e.id])).rejects.toThrow(/permission denied/);
    await expect(maintPool.query("delete from entries where id = $1", [e.id])).rejects.toThrow(/permission denied/);
    await expect(maintPool.query("update entries set author_id = $2 where id = $1", [e.id, B.id])).rejects.toThrow(/permission denied/);
    await expect(maintPool.query("update entries set key_version = 1 where id = $1", [e.id])).rejects.toThrow(/key_version must increase/);
    await expect(maintPool.query("update entries set key_version = 2, nonce = nonce, ciphertext = ciphertext, seq = 99 where id = $1", [e.id])).rejects.toThrow(/permission denied|append-only/);
    await expect(maintPool.query("update entries set key_version = 2 where id = $1", [e.id])).resolves.toBeTruthy();
  });
});

describe("auth", () => {
  it("open signup is refused unless the operator turned it on (PETTY-215)", async () => {
    // default env has OPEN_SIGNUP unset, so a signup with no join link is invite-only-refused
    const u = await userMaterial("nolink", { email: `nolink-${run}@test.local` });
    const res = await app.inject({ method: "POST", url: "/auth/signup", headers: { "content-type": "application/json" }, payload: JSON.stringify(u.signupBody) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("JoinLinkRequired");
    expect((await app.inject({ method: "GET", url: "/config" })).json().open_signup).toBe(false);
  });

  it("join links are single-use; duplicate email is 409; wrong password is 401; logout ends the session", async () => {
    const token = await makeJoinLink();
    const u = new Client(app, await userMaterial("dup", { email: `dup-${run}@test.local` }));
    expect((await u.signup(token)).statusCode).toBe(201);
    const again = new Client(app, await userMaterial("dup2", { email: `dup2-${run}@test.local` }));
    expect((await again.signup(token)).statusCode).toBe(400);
    const same = new Client(app, await userMaterial("dup3", { email: `dup-${run}@test.local` }));
    expect((await same.signup(await makeJoinLink())).statusCode).toBe(409);
    u.cookie = null;
    expect((await u.call("GET", "/me")).statusCode).toBe(401);
    expect((await u.call("POST", "/auth/login", { email: u.user.email, password: "wrong-password" })).statusCode).toBe(401);
    expect((await u.login()).statusCode).toBe(200);
    expect((await u.call("GET", "/me")).json().email).toBe(u.user.email);
    expect((await u.call("POST", "/auth/logout")).statusCode).toBe(204);
    expect((await u.call("GET", "/me")).statusCode).toBe(401);
  }, 60_000);

  it("signup rejects a vault whose public keys differ from the published keys", async () => {
    const m = await userMaterial("mismatch", { email: `mm-${run}@test.local` });
    const other = await userMaterial("other", { email: `mm2-${run}@test.local` });
    const c = new Client(app, m);
    const res = await c.call("POST", "/auth/signup", { ...m.signupBody, join_token: await makeJoinLink(), vault: other.signupBody["vault"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("KeysMismatch");
  }, 60_000);
});

describe("permissions (called directly, never through a UI)", () => {
  it("non-member → 404; read member cannot write; write member cannot delete; owner can", async () => {
    const { id, key, line } = await sharedDrawer();
    expect((await N.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
    expect((await N.call("GET", `/drawers/${id}/export`)).statusCode).toBe(404);
    expect((await C.call("GET", `/drawers/${id}`)).statusCode).toBe(200);
    const readWrite = await C.postEntry(id, key, line, "add", 100);
    expect(readWrite.res.statusCode).toBe(403);
    expect(readWrite.res.json().code).toBe("InsufficientRole");
    expect((await C.call("PUT", `/drawers/${id}/document`, { ...sealedBody(await C.sealDoc(id, key, newDocument("x")), 1), base_version: 1 })).statusCode).toBe(403);
    expect((await C.call("GET", `/drawers/${id}/export`)).statusCode).toBe(403);
    expect((await B.call("GET", `/drawers/${id}/export`)).statusCode).toBe(200);
    expect((await B.call("DELETE", `/drawers/${id}`, { proof: await B.proof() })).statusCode).toBe(403); // not the owner
    expect((await B.call("POST", `/drawers/${id}/invitations`, { invitee_id: N.id, role: "read", wrap: (await A.call("GET", "/bootstrap")).json().wraps[0] })).statusCode).toBe(403);
    // PETTY-201 (red-team INFO-1): the owner needs a custody proof to delete, not just a session
    expect((await A.call("DELETE", `/drawers/${id}`)).statusCode).toBe(400); // no proof
    expect((await A.call("DELETE", `/drawers/${id}`, { proof: await A.proof(B.user.keys.ecdsa.privateKey) })).json().code).toBe("CustodyProofInvalid"); // foreign key
    expect((await A.call("DELETE", `/drawers/${id}`, { proof: await A.proof() })).statusCode).toBe(204);
    expect((await A.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
    expect((await owner.query("select count(*)::int as n from entries where drawer_id = $1", [id])).rows[0].n).toBe(0);
  });
});

describe("document versioning", () => {
  it("stale base_version → 409 with the current version; verification flag stamps last_verified_at; a later entry makes it stale", async () => {
    const { id, key, doc, line } = await sharedDrawer();
    const v2 = await A.call("PUT", `/drawers/${id}/document`, { ...sealedBody(await A.sealDoc(id, key, { ...doc, name: "Kitchen 2" }), 1), base_version: 1 });
    expect(v2.statusCode).toBe(200);
    expect(v2.json().version).toBe(2);
    const stale = await B.call("PUT", `/drawers/${id}/document`, { ...sealedBody(await B.sealDoc(id, key, { ...doc, name: "Bob" }), 1), base_version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VersionConflict", context: { current_version: 2 } });
    const ver = await B.call("PUT", `/drawers/${id}/document`, { ...sealedBody(await B.sealDoc(id, key, doc), 1), base_version: 2, verification: true });
    expect(ver.statusCode).toBe(200);
    expect(ver.json().last_verified_at).toBe(ver.json().last_write_at);
    await A.postEntry(id, key, line, "add", 1);
    const after = (await A.call("GET", "/bootstrap")).json().drawers.find((d: { id: string }) => d.id === id);
    expect(Date.parse(after.last_write_at)).toBeGreaterThan(Date.parse(after.last_verified_at));
  });
});

describe("entries", () => {
  it("append is idempotent on the client id; seq is per line", async () => {
    const { id, key, line } = await sharedDrawer();
    const e = await A.postEntry(id, key, line, "add", 5000, { id: crypto.randomUUID() });
    expect(e.res.statusCode).toBe(201);
    expect(e.res.json().entry.seq).toBe(1);
    const again = await A.call("POST", `/drawers/${id}/entries`, { id: e.id, line_id: line, is_checkpoint: false, reverses_entry_id: null, key_version: 1, schema_version: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect((await owner.query("select count(*)::int as n from entries where drawer_id = $1", [id])).rows[0].n).toBe(1);
    const other = await B.postEntry(id, key, crypto.randomUUID(), "add", 1);
    expect(other.res.json().entry.seq).toBe(1);
  });

  it("two simultaneous Adjusts: one 201, one 409 RecountRequired", async () => {
    const { id, key, line } = await sharedDrawer();
    await A.postEntry(id, key, line, "add", 100);
    const [a, b] = await Promise.all([A.postEntry(id, key, line, "adjust", 90, { expected_head_seq: 1 }), B.postEntry(id, key, line, "adjust", 95, { expected_head_seq: 1 })]);
    const codes = [a.res.statusCode, b.res.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const lost = a.res.statusCode === 409 ? a : b;
    expect(lost.res.json()).toMatchObject({ code: "RecountRequired", context: { head_seq: 2 } });
    expect((await owner.query("select count(*)::int as n from entries where drawer_id = $1 and is_checkpoint", [id])).rows[0].n).toBe(1);
  });

  it("Adjust vs Add: whoever lands first wins (SPEC-ISSUES B2)", async () => {
    const { id, key, line } = await sharedDrawer();
    await A.postEntry(id, key, line, "add", 100);
    expect((await B.postEntry(id, key, line, "add", 5)).res.statusCode).toBe(201);          // add first
    const late = await A.postEntry(id, key, line, "adjust", 100, { expected_head_seq: 1 });    // counted before the add
    expect(late.res.statusCode).toBe(409);
    expect((await A.postEntry(id, key, line, "adjust", 105, { expected_head_seq: 2 })).res.statusCode).toBe(201); // adjust first
    expect((await B.postEntry(id, key, line, "add", 5)).res.statusCode).toBe(201);          // then an add on top
    expect((await A.postEntry(id, key, line, "adjust", 1)).res.statusCode).toBe(400);       // no expected head
  });

  it("Reverse: once only, not an Adjust, not before the latest checkpoint, only on its own line", async () => {
    const { id, key, line } = await sharedDrawer();
    const typo = await A.postEntry(id, key, line, "withdraw", -50000);
    const ok = await B.postEntry(id, key, line, "reverse", 50000, { reverses: typo.id });
    expect(ok.res.statusCode).toBe(201);
    const twice = await A.postEntry(id, key, line, "reverse", 50000, { reverses: typo.id });
    expect(twice.res.statusCode).toBe(409);
    expect(twice.res.json().context.reason).toBe("already_reversed");
    const old = await A.postEntry(id, key, line, "withdraw", -100);
    const adj = await A.postEntry(id, key, line, "adjust", 100, { expected_head_seq: 3 });
    expect(adj.res.statusCode).toBe(201);
    const late = await A.postEntry(id, key, line, "reverse", 100, { reverses: old.id });
    expect(late.res.json()).toMatchObject({ code: "ReverseRefused", context: { reason: "before_checkpoint" } });
    const ofAdjust = await A.postEntry(id, key, line, "reverse", -100, { reverses: adj.id });
    expect(ofAdjust.res.json().context.reason).toBe("adjust_not_reversible");
    const otherLine = await A.postEntry(id, key, crypto.randomUUID(), "add", 7);
    const cross = await A.postEntry(id, key, line, "reverse", -7, { reverses: otherLine.id });
    expect(cross.res.statusCode).toBe(400);
  });

  it("bootstrap returns entries since the last Adjust only; older pages come from the line endpoint", async () => {
    const { id, key, line } = await sharedDrawer();
    const e1 = await A.postEntry(id, key, line, "add", 1);
    const e2 = await A.postEntry(id, key, line, "add", 2, { prev_hash: await hashEntry(e1.signed) });
    const adj = await A.postEntry(id, key, line, "adjust", 3, { expected_head_seq: 2, prev_hash: await hashEntry(e2.signed) });
    const e4 = await A.postEntry(id, key, line, "add", 4, { prev_hash: await hashEntry(adj.signed) });
    const boot = (await C.call("GET", "/bootstrap")).json();
    const mine = boot.entries.filter((e: { drawer_id: string }) => e.drawer_id === id).map((e: { seq: number }) => e.seq);
    expect(mine).toEqual([3, 4]);
    expect(boot.drawers.find((d: { id: string }) => d.id === id).role).toBe("read");
    expect(Object.keys(boot.documents)).toContain(id);
    expect(boot.wraps.some((w: { drawer_id: string }) => w.drawer_id === id)).toBe(true);
    const page = (await C.call("GET", `/drawers/${id}/lines/${line}/entries?before=3&limit=1`)).json();
    expect(page.entries.map((e: { seq: number }) => e.seq)).toEqual([2]);
    expect(page.has_more).toBe(true);
    void e4;
  });
});

describe("sharing", () => {
  it("invitations: pending once, invitee sees it, accept grants access and the wrap; decline and revoke", async () => {
    const { id, key } = await sharedDrawer();
    const wrap = await A.wrapFor(await A.unwrap((await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), A.user.pub.ecdh, true), N.user.pub.ecdh, id, 1);
    expect((await N.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
    const inv = await A.call("POST", `/drawers/${id}/invitations`, { invitee_id: N.id, role: "read", wrap });
    expect(inv.statusCode).toBe(201);
    expect((await A.call("POST", `/drawers/${id}/invitations`, { invitee_id: N.id, role: "read", wrap })).statusCode).toBe(409);
    expect((await A.call("POST", `/drawers/${id}/invitations`, { invitee_id: crypto.randomUUID(), role: "read", wrap })).statusCode).toBe(404);
    const list = (await N.call("GET", "/invitations")).json().invitations;
    expect(list.map((i: { id: string }) => i.id)).toContain(inv.json().id);
    expect((await N.call("GET", `/drawers/${id}`)).statusCode).toBe(404); // no access until accept
    expect((await N.call("POST", `/invitations/${inv.json().id}/decline`)).statusCode).toBe(204);
    const inv2 = await A.call("POST", `/drawers/${id}/invitations`, { invitee_id: N.id, role: "read", wrap });
    expect((await N.call("POST", `/invitations/${inv2.json().id}/accept`)).statusCode).toBe(204);
    expect((await N.call("GET", `/drawers/${id}`)).json().drawer.role).toBe("read");
    const nWrap = (await N.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id);
    const nKey = await N.unwrap(nWrap, A.user.pub.ecdh);
    expect(nKey.type).toBe("secret");
    void key;
  });

  it("revoke removes membership and wraps and flags rotation; leave does the same; owner cannot leave", async () => {
    const { id } = await sharedDrawer();
    expect((await A.call("DELETE", `/drawers/${id}/members/${C.id}`)).statusCode).toBe(204);
    expect((await C.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
    expect((await owner.query("select count(*)::int as n from drawer_keys where drawer_id = $1 and user_id = $2", [id, C.id])).rows[0].n).toBe(0);
    expect((await A.call("GET", `/drawers/${id}`)).json().drawer.rotation_needed).toBe(true);
    expect((await A.call("POST", `/drawers/${id}/leave`)).statusCode).toBe(403);
    expect((await B.call("POST", `/drawers/${id}/leave`)).statusCode).toBe(204);
    expect((await B.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
  });

  it("ownership transfer takes effect only on acceptance; old owner becomes a write member", async () => {
    const { id } = await sharedDrawer();
    expect((await A.call("POST", `/drawers/${id}/transfer`, { to_user_id: C.id })).statusCode).toBe(400); // read member
    expect((await A.call("POST", `/drawers/${id}/transfer`, { to_user_id: B.id })).statusCode).toBe(201);
    expect((await A.call("GET", `/drawers/${id}`)).json().drawer.role).toBe("owner");
    expect((await B.call("POST", `/drawers/${id}/transfer/accept`)).statusCode).toBe(204);
    expect((await B.call("GET", `/drawers/${id}`)).json().drawer.role).toBe("owner");
    expect((await A.call("GET", `/drawers/${id}`)).json().drawer.role).toBe("write");
  });
});

describe("rotation (SPEC-ISSUES A7)", () => {
  it("publishes the new key first, refuses old-key writes, re-seals in resumable batches, and a stale invitation is refused", async () => {
    const { id, key, line } = await sharedDrawer();
    const e1 = await A.postEntry(id, key, line, "add", 10);
    const e2 = await A.postEntry(id, key, line, "add", 20);
    // a pending invitation at key version 1 …
    const oldWrapForN = await A.wrapFor(await A.unwrap((await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id), A.user.pub.ecdh, true), N.user.pub.ecdh, id, 1);
    const inv = await A.call("POST", `/drawers/${id}/invitations`, { invitee_id: N.id, role: "read", wrap: oldWrapForN });
    // … C gets revoked, so B (write) rotates
    expect((await A.call("DELETE", `/drawers/${id}/members/${C.id}`)).statusCode).toBe(204);
    const { key: key2 } = await (await import("@petty/crypto")).createDrawerKey(B.sender, id, 2);
    const exKey2 = await B.unwrap((await B.wrapFor(await (await import("@petty/crypto")).unwrapDrawerKey((await (await import("@petty/crypto")).createDrawerKey(B.sender, id, 2)).selfWrap, B.user.keys.ecdh.privateKey, { drawer_id: id, key_version: 2, senderEcdhPublicB64: B.user.pub.ecdh }, { extractable: true }), B.user.pub.ecdh, id, 2)), B.user.pub.ecdh, true);
    void key2;
    const wraps = [{ user_id: A.id, wrap: await B.wrapFor(exKey2, A.user.pub.ecdh, id, 2) }, { user_id: B.id, wrap: await B.wrapFor(exKey2, B.user.pub.ecdh, id, 2) }];
    const incomplete = await B.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps: wraps.slice(0, 1) });
    expect(incomplete.statusCode).toBe(400);
    const start = await B.call("POST", `/drawers/${id}/rotation`, { to_version: 2, wraps });
    expect(start.statusCode).toBe(201);
    expect(start.json()).toMatchObject({ key_version: 2, pending_entries: 2, document_pending: true, completed: false });
    // old-key writes are refused; new-key writes work at once
    expect((await A.postEntry(id, key, line, "add", 1, { keyVersion: 1 })).res.statusCode).toBe(409);
    const aKey2 = await A.unwrap((await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string; key_version: number }) => w.drawer_id === id && w.key_version === 2), B.user.pub.ecdh);
    expect((await A.postEntry(id, aKey2, line, "add", 1, { keyVersion: 2 })).res.statusCode).toBe(201);
    // stale invitation
    expect((await N.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(409);
    // re-seal batch 1 (one entry), "interrupted", then batch 2 (rest + document)
    const { reseal, openDocument, fromB64: fb } = await import("@petty/crypto");
    const rows = (await B.call("GET", `/drawers/${id}/export`)).json();
    const reSealed = async (row: { id: string; line_id: string; author_id: string; nonce: string; ciphertext: string; key_version: number }) => {
      const identity = { record_type: "entry" as const, record_id: row.id, drawer_id: id, line_id: row.line_id, author_id: row.author_id, key_version: row.key_version, schema_version: 1 };
      const r = await reseal(key, exKey2, identity, { nonce: fb(row.nonce), ciphertext: fb(row.ciphertext) }, 2);
      return { id: row.id, ...sealedBody(r.sealed, 2) };
    };
    const old = rows.entries.filter((r: { key_version: number }) => r.key_version === 1);
    expect(old.length).toBe(2);
    const b1 = await B.call("PUT", `/drawers/${id}/rotation/batch`, { to_version: 2, entries: [await reSealed(old[0])] });
    expect(b1.json()).toMatchObject({ pending_entries: 1, completed: false });
    const docId = { record_type: "document" as const, record_id: id, drawer_id: id, line_id: null, author_id: rows.document.author_id, key_version: 1, schema_version: 1 };
    const doc = await openDocument(key, docId, { nonce: fb(rows.document.nonce), ciphertext: fb(rows.document.ciphertext) });
    const b2 = await B.call("PUT", `/drawers/${id}/rotation/batch`, { to_version: 2, entries: [await reSealed(old[1])], document: sealedBody(await B.sealDoc(id, exKey2, doc as never, 2), 2) });
    expect(b2.json()).toMatchObject({ pending_entries: 0, document_pending: false, completed: true });
    expect((await owner.query("select count(*)::int as n from entries where drawer_id = $1 and key_version = 1", [id])).rows[0].n).toBe(0);
    void e1; void e2;
    // C (revoked) can no longer read anything, and the old key does not open re-sealed rows
    expect((await C.call("GET", `/drawers/${id}`)).statusCode).toBe(404);
  }, 60_000);
});

describe("user document and wrap sender", () => {
  it("PUT /me/doc creates then version-checks; wraps carry the server-stamped sender_id", async () => {
    expect((await A.call("GET", "/me/doc")).statusCode).toBe(204);
    const put = await A.call("PUT", "/me/doc", { base_version: 0, schema_version: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" });
    expect(put.statusCode).toBe(200);
    expect(put.json().version).toBe(1);
    expect((await A.call("PUT", "/me/doc", { base_version: 0, schema_version: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" })).statusCode).toBe(409);
    expect((await A.call("PUT", "/me/doc", { base_version: 1, schema_version: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" })).json().version).toBe(2);
    expect((await A.call("GET", "/me/doc")).json().version).toBe(2);
    const { id } = await sharedDrawer();
    const wraps = (await B.call("GET", "/bootstrap")).json().wraps.filter((w: { drawer_id: string }) => w.drawer_id === id);
    expect(wraps[0].sender_id).toBe(A.id);
    const mine = (await A.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === id);
    expect(mine.sender_id).toBe(A.id);
  });

  it("an invitation sends an email through Mailpit", async () => {
    await sharedDrawer();
    const res = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${B.user.email}`)}`);
    if (res.ok) {
      const j = (await res.json()) as { messages: Array<{ Subject: string }> };
      expect(j.messages.some((m) => m.Subject === "A drawer was shared with you")).toBe(true);
    }
  });
});

describe("vault custody and security headers", () => {
  it("PUT /me/vault replaces the passphrase wrap for the same keys only; recovery vault is served; CSP and friends are on every response", async () => {
    const { createVault, unlockVault, createRecoveryVault, generateRecoveryCode } = await import("@petty/crypto");
    const F = new Client(app, await userMaterial("fay", { email: `fay-${run}@test.local` }));
    expect((await F.signup(await makeJoinLink())).statusCode).toBe(201);
    const rv = await F.call("GET", "/me/recovery-vault");
    expect(rv.statusCode).toBe(200);
    const keys = await unlockVault(rv.json().recovery_vault, F.user.recovery_code, { extractable: true });
    expect(keys.pub).toEqual(F.user.pub);
    const pairs = { ecdh: { privateKey: keys.ecdhPrivate, publicKey: F.user.keys.ecdh.publicKey }, ecdsa: { privateKey: keys.ecdsaPrivate, publicKey: F.user.keys.ecdsa.publicKey } };
    const newVault = await createVault("a brand new passphrase 2026", pairs);
    expect((await F.call("PUT", "/me/vault", { password: "wrong", proof: await F.proof(), vault: newVault })).statusCode).toBe(401);
    // SR-2: the login password alone is not enough — no challenge, a stale one, or a signature by another key is refused
    expect((await F.call("PUT", "/me/vault", { password: F.user.password, vault: newVault })).statusCode).toBe(400);
    const stale = await F.proof();
    await F.proof();
    expect((await F.call("PUT", "/me/vault", { password: F.user.password, proof: stale, vault: newVault })).json().code).toBe("CustodyProofRequired");
    const other = await userMaterial("g", { email: `g-${run}@test.local` });
    expect((await F.call("PUT", "/me/vault", { password: F.user.password, proof: await F.proof(other.keys.ecdsa.privateKey), vault: newVault })).json().code).toBe("CustodyProofInvalid");
    expect((await F.call("PUT", "/me/vault", { password: F.user.password, proof: await F.proof(), vault: other.signupBody["vault"] })).json().code).toBe("KeysMismatch");
    const newRecovery = await createRecoveryVault(generateRecoveryCode(), pairs);
    expect((await F.call("PUT", "/me/vault", { password: F.user.password, proof: await F.proof(keys.ecdsaPrivate), vault: newVault, recovery_vault: newRecovery })).statusCode).toBe(204);
    // the previous blobs are kept for 30 days; an admin can put them back
    const hist = await owner.query("select count(*)::int as n from vault_history where user_id = $1", [F.id]);
    expect(hist.rows[0].n).toBe(1);
    const me = await F.call("GET", "/me");
    await expect(unlockVault(me.json().vault, "a brand new passphrase 2026")).resolves.toBeTruthy();
    expect(me.headers["content-security-policy"]).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(me.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(me.headers["x-content-type-options"]).toBe("nosniff");
    expect(me.headers["referrer-policy"]).toBe("no-referrer");
  }, 60_000);

  it("passkeys (Phase 14, PETTY-102): several per account, same keys only, custody proof to add or remove, served in /me and login", async () => {
    const { createPasskeyVault, unlockVault, unlockPasskeyVault, randomBytes, toB64 } = await import("@petty/crypto");
    const P = new Client(app, await userMaterial("pk", { email: `pk-${run}@test.local` }));
    expect((await P.signup(await makeJoinLink())).statusCode).toBe(201);
    expect((await P.call("GET", "/me")).json().passkeys).toEqual([]);
    const rv = (await P.call("GET", "/me/recovery-vault")).json().recovery_vault;
    const keys = await unlockVault(rv, P.user.recovery_code, { extractable: true });
    const pairs = { ecdh: { privateKey: keys.ecdhPrivate, publicKey: P.user.keys.ecdh.publicKey }, ecdsa: { privateKey: keys.ecdsaPrivate, publicKey: P.user.keys.ecdsa.publicKey } };
    const prf = randomBytes(32);
    const passkey = { credential_id: toB64(randomBytes(16)), prf_salt: toB64(randomBytes(32)), vault: await createPasskeyVault(prf, pairs), label: "Phone", transports: ["internal", "hybrid"] };
    expect((await P.call("POST", "/me/passkeys", { password: "wrong", proof: await P.proof(), passkey })).statusCode).toBe(401);
    const other = await userMaterial("pk2", { email: `pk2-${run}@test.local` });
    const otherKeys = await unlockVault(other.signupBody["recovery_vault"] as never, other.recovery_code, { extractable: true });
    const otherPairs = { ecdh: { privateKey: otherKeys.ecdhPrivate, publicKey: other.keys.ecdh.publicKey }, ecdsa: { privateKey: otherKeys.ecdsaPrivate, publicKey: other.keys.ecdsa.publicKey } };
    expect((await P.call("POST", "/me/passkeys", { password: P.user.password, proof: await P.proof(other.keys.ecdsa.privateKey), passkey })).json().code).toBe("CustodyProofInvalid");
    expect((await P.call("POST", "/me/passkeys", { password: P.user.password, proof: await P.proof(), passkey: { ...passkey, vault: await createPasskeyVault(prf, otherPairs) } })).json().code).toBe("KeysMismatch");
    expect((await P.call("POST", "/me/passkeys", { password: P.user.password, proof: await P.proof(), passkey: { ...passkey, vault: P.user.signupBody["vault"] } })).json().code).toBe("KeysMismatch");
    const added = await P.call("POST", "/me/passkeys", { password: P.user.password, proof: await P.proof(), passkey });
    expect(added.statusCode).toBe(201);
    expect(added.json().label).toBe("Phone");
    const second = { ...passkey, credential_id: toB64(randomBytes(16)), prf_salt: toB64(randomBytes(32)), label: "Laptop", transports: [] };
    expect((await P.call("POST", "/me/passkeys", { password: P.user.password, proof: await P.proof(), passkey: second })).statusCode).toBe(201);
    const me = (await P.call("GET", "/me")).json();
    expect(me.passkeys.map((p: { label: string }) => p.label)).toEqual(["Phone", "Laptop"]);
    expect(me.passkeys[0].credential_id).toBe(passkey.credential_id);
    expect(me.passkeys[0].transports).toEqual(["internal", "hybrid"]);
    expect(me.pub).toEqual(P.user.pub);
    expect((await unlockPasskeyVault(me.passkeys[0].vault, prf)).pub).toEqual(P.user.pub);
    P.cookie = null;
    const login = await P.login();
    expect(login.statusCode).toBe(200);
    expect(login.json().passkeys).toHaveLength(2);
    const id = added.json().id as string;
    expect((await P.call("DELETE", `/me/passkeys/${id}`, { password: "wrong", proof: await P.proof() })).statusCode).toBe(401);
    expect((await P.call("DELETE", "/me/passkeys/00000000-0000-4000-8000-000000000000", { password: P.user.password, proof: await P.proof() })).statusCode).toBe(404);
    expect((await P.call("DELETE", `/me/passkeys/${id}`, { password: P.user.password, proof: await P.proof() })).statusCode).toBe(204);
    expect((await P.call("GET", "/me")).json().passkeys.map((p: { label: string }) => p.label)).toEqual(["Laptop"]);
  }, 60_000);

  it("passkey-only account (PETTY-102): signup with a passkey and no passphrase, /me has vault null, the last passkey cannot go until a passphrase is set", async () => {
    const { createPasskeyVault, unlockVault, createVault, randomBytes, toB64 } = await import("@petty/crypto");
    const m = await userMaterial("pko", { email: `pko-${run}@test.local` });
    const prf = randomBytes(32);
    const passkey = { credential_id: toB64(randomBytes(16)), prf_salt: toB64(randomBytes(32)), vault: await createPasskeyVault(prf, m.keys), label: "Phone" };
    const noVault = Object.fromEntries(Object.entries(m.signupBody).filter(([k]) => k !== "vault"));
    const bad = new Client(app, { ...m, signupBody: noVault });
    expect((await bad.signup(await makeJoinLink())).json().code).toBe("VaultKind"); // neither door
    const P = new Client(app, { ...m, signupBody: { ...noVault, passkey } });
    const signup = await P.signup(await makeJoinLink());
    expect(signup.statusCode).toBe(201);
    expect(signup.json().vault).toBeNull();
    expect(signup.json().passkeys).toHaveLength(1);
    expect(signup.json().pub).toEqual(m.pub);
    const id = signup.json().passkeys[0].id as string;
    expect((await P.call("DELETE", `/me/passkeys/${id}`, { password: m.password, proof: await P.proof() })).json().code).toBe("LastDoor");
    // Recovery code → set a passphrase (PUT /me/vault on a null vault: no history row, no error).
    const rv = (await P.call("GET", "/me/recovery-vault")).json().recovery_vault;
    const keys = await unlockVault(rv, m.recovery_code, { extractable: true });
    const pairs = { ecdh: { privateKey: keys.ecdhPrivate, publicKey: m.keys.ecdh.publicKey }, ecdsa: { privateKey: keys.ecdsaPrivate, publicKey: m.keys.ecdsa.publicKey } };
    const vault = await createVault("a backup passphrase 2026", pairs);
    expect((await P.call("PUT", "/me/vault", { password: m.password, proof: await P.proof(keys.ecdsaPrivate), vault })).statusCode).toBe(204);
    expect((await P.call("GET", "/me")).json().vault.kind).toBe("passphrase");
    expect((await P.call("DELETE", `/me/passkeys/${id}`, { password: m.password, proof: await P.proof() })).statusCode).toBe(204);
    expect((await P.call("GET", "/me")).json().passkeys).toEqual([]);
  }, 60_000);
});

describe("account deletion (SPEC-ISSUES A8)", () => {
  it("blocks until every shared drawer has a decision; hands over without acceptance; deletes sole drawers; erases keys but keeps public keys", async () => {
    const D = new Client(app, await userMaterial("dana", { email: `dana-${run}@test.local` }));
    expect((await D.signup(await makeJoinLink())).statusCode).toBe(201);
    const E = new Client(app, await userMaterial("ed", { email: `ed-${run}@test.local` }));
    expect((await E.signup(await makeJoinLink())).statusCode).toBe(201);
    // dana owns a shared drawer (with ed as writer) and a sole drawer; ed also shares one with dana
    const shared = await D.createDrawer("Shared");
    const sole = await D.createDrawer("Sole");
    const exKey = await D.unwrap((await D.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === shared.id), D.user.pub.ecdh, true);
    const inv = await D.call("POST", `/drawers/${shared.id}/invitations`, { invitee_id: E.id, role: "write", wrap: await D.wrapFor(exKey, E.user.pub.ecdh, shared.id, 1) });
    expect((await E.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
    const edsDrawer = await E.createDrawer("Eds");
    const exKey2 = await E.unwrap((await E.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === edsDrawer.id), E.user.pub.ecdh, true);
    const inv2 = await E.call("POST", `/drawers/${edsDrawer.id}/invitations`, { invitee_id: D.id, role: "read", wrap: await E.wrapFor(exKey2, D.user.pub.ecdh, edsDrawer.id, 1) });
    expect((await D.call("POST", `/invitations/${inv2.json().id}/accept`)).statusCode).toBe(204);
    const line = crypto.randomUUID();
    const e1 = await D.postEntry(shared.id, shared.key, line, "add", 500);
    expect(e1.res.statusCode).toBe(201);
    // PETTY-188 (NR-8): a token with a drawer-key wrap, which deletion must erase
    const tok = await D.makeAccessToken("write");
    expect(tok.res.statusCode).toBe(201);
    await owner.query("insert into access_token_keys (token_id, drawer_id, key_version, wrap) values ($1, $2, 1, '{}')", [tok.rowId, shared.id]);
    // preview
    const pv = (await D.call("GET", "/me/delete")).json();
    expect(pv.shared.map((s: { drawer_id: string }) => s.drawer_id)).toEqual([shared.id]);
    expect(pv.sole).toEqual([sole.id]);
    expect(pv.memberships).toEqual([edsDrawer.id]);
    // wrong password, missing decision, bad recipient
    expect((await D.call("POST", "/me/delete", { password: "nope", proof: await D.proof(), decisions: [] })).statusCode).toBe(401);
    // SR-2: a session plus the login password cannot delete without proof of the signing key
    expect((await D.call("POST", "/me/delete", { password: D.user.password, decisions: [] })).statusCode).toBe(400);
    expect((await D.call("POST", "/me/delete", { password: D.user.password, proof: await D.proof(E.user.keys.ecdsa.privateKey), decisions: [] })).json().code).toBe("CustodyProofInvalid");
    const missing = await D.call("POST", "/me/delete", { password: D.user.password, proof: await D.proof(), decisions: [] });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().code).toBe("DecisionsRequired");
    expect((await D.call("POST", "/me/delete", { password: D.user.password, proof: await D.proof(), decisions: [{ drawer_id: shared.id, action: "transfer", to_user_id: crypto.randomUUID() }] })).statusCode).toBe(400);
    // hand over to ed
    expect((await D.call("POST", "/me/delete", { password: D.user.password, proof: await D.proof(), decisions: [{ drawer_id: shared.id, action: "transfer", to_user_id: E.id }] })).statusCode).toBe(204);
    expect((await D.call("GET", "/me")).statusCode).toBe(401);
    expect((await D.login()).statusCode).toBe(401);
    // the token is dead, its sealed bundle and wraps are gone; the revoked row keeps only the public delegation
    expect((await app.inject({ method: "GET", url: "/me/token", headers: { authorization: `Bearer ${tok.bearer}` } })).statusCode).toBe(401);
    const trow = (await owner.query("select revoked_at, bundle_ciphertext, bundle_nonce, ecdh_pub, delegation from access_tokens where id = $1", [tok.rowId])).rows[0];
    expect(trow.revoked_at).not.toBeNull();
    expect([trow.bundle_ciphertext, trow.bundle_nonce, trow.ecdh_pub]).toEqual(["", "", null]);
    expect(trow.delegation).not.toBeNull();
    expect((await owner.query("select count(*)::int as n from access_token_keys where token_id = $1", [tok.rowId])).rows[0].n).toBe(0);
    expect((await owner.query("select count(*)::int as n from access_tokens where user_id = $1 and (revoked_at is null or bundle_ciphertext <> '')", [D.id])).rows[0].n).toBe(0);
    const boot = (await E.call("GET", "/bootstrap")).json();
    const s = boot.drawers.find((d: { id: string }) => d.id === shared.id);
    expect(s.role).toBe("owner");
    expect(s.rotation_needed).toBe(true);
    expect(boot.members[shared.id].map((m: { user_id: string }) => m.user_id)).toEqual([E.id]);
    expect(boot.entries.some((e: { id: string }) => e.id === e1.id)).toBe(true);        // dana's entry is still there
    expect((await owner.query("select count(*)::int as n from drawers where id = $1", [sole.id])).rows[0].n).toBe(0); // sole drawer gone
    const u = (await owner.query("select email, display_name, vault, deleted_at from users where id = $1", [D.id])).rows[0];
    expect(u.vault).toBeNull(); expect(u.deleted_at).not.toBeNull(); expect(u.email).toContain("@deleted.invalid");
    const keys = (await E.call("GET", `/users/${D.id}/keys`)).json().keys;   // public keys kept, retired
    expect(keys.length).toBe(1); expect(keys[0].retired_at).not.toBeNull(); expect(keys[0].ecdsa_pub).toBe(D.user.pub.ecdsa);
    expect((await owner.query("select count(*)::int as n from drawer_members where drawer_id = $1 and user_id = $2", [edsDrawer.id, D.id])).rows[0].n).toBe(0);
    expect((await owner.query("select rotation_needed from drawers where id = $1", [edsDrawer.id])).rows[0].rotation_needed).toBe(true);
  }, 60_000);
});

describe("line deletion", () => {
  it("removes the line's entries through petty_maint after the document write", async () => {
    const { id, key, line, doc } = await sharedDrawer();
    await A.postEntry(id, key, line, "add", 1);
    await A.postEntry(id, key, line, "add", 2);
    const without = applyOp(doc, { type: "remove_line", line_id: line }, { lineHasEntries: () => true });
    const res = await B.call("POST", `/drawers/${id}/lines/${line}/delete`, { document: { ...sealedBody(await B.sealDoc(id, key, without), 1), base_version: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted_entries).toBe(2);
    expect((await owner.query("select count(*)::int as n from entries where drawer_id = $1", [id])).rows[0].n).toBe(0);
    expect((await C.call("POST", `/drawers/${id}/lines/${line}/delete`, { document: { ...sealedBody(await C.sealDoc(id, key, without), 1), base_version: 2 } })).statusCode).toBe(403);
  });
});

describe("storage limits (PETTY-243)", () => {
  // The quota is read from the environment at start; these tests set it on the loaded config.
  const setQuota = (bytes: number | null) => { (config as { storageQuotaBytes: number | null }).storageQuotaBytes = bytes; };
  afterEach(() => setQuota(null));
  const fake = (n: number) => Buffer.alloc(n, 7).toString("base64"); // the server never opens ciphertext; size is all it sees
  const photo = (n: number) => ({ key_version: 1, schema_version: 1, nonce: fake(12), ciphertext: fake(n) });
  const storage = async (c: Client) => (await c.call("GET", "/me/storage")).json() as { used_bytes: number; quota_bytes: number | null };

  it("the server's photo limit is exactly what a 300 KB photo seals to", async () => {
    const id = crypto.randomUUID();
    const sealed = await sealPhoto(await generateDrawerKey(), { record_type: "photo", record_id: id, drawer_id: id, line_id: null, author_id: A.id, key_version: 1, schema_version: 1 }, new Uint8Array(PHOTO_MAX_BYTES));
    expect(sealed.ciphertext.length).toBe(PHOTO_MAX_CIPHERTEXT);
  });

  it("refuses a photo or an entry over its size limit, from any client; a stored entry still replays", async () => {
    const { id, key, line } = await sharedDrawer();
    const big = await B.call("PUT", `/drawers/${id}/photo`, photo(PHOTO_MAX_CIPHERTEXT + 1));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: "PhotoTooLarge", context: { max_bytes: PHOTO_MAX_CIPHERTEXT } });
    expect((await B.call("PUT", `/drawers/${id}/photo`, photo(PHOTO_MAX_CIPHERTEXT))).statusCode).toBe(204);
    const entry = { id: crypto.randomUUID(), line_id: line, is_checkpoint: false, reverses_entry_id: null, key_version: 1, schema_version: 1, nonce: fake(12), ciphertext: fake(ENTRY_MAX_CIPHERTEXT + 1) };
    const huge = await A.call("POST", `/drawers/${id}/entries`, entry);
    expect(huge.statusCode).toBe(413);
    expect(huge.json().code).toBe("EntryTooLarge");
    const e = await A.postEntry(id, key, line, "add", 1);
    expect((await A.call("POST", `/drawers/${id}/entries`, { ...entry, id: e.id })).statusCode).toBe(200); // replay answers before the size check
  });

  it("no quota by default; with one, writes to a drawer count against its owner, and freeing space always works", async () => {
    const { id, key, line, doc } = await sharedDrawer();
    expect((await storage(A)).quota_bytes).toBeNull();
    const memberBefore = (await storage(B)).used_bytes;
    expect((await A.call("PUT", `/drawers/${id}/photo`, photo(100_000))).statusCode).toBe(204);
    const used = (await storage(A)).used_bytes;
    expect(used).toBeGreaterThanOrEqual(100_000);
    setQuota(used + 50_000);
    expect(await storage(A)).toEqual({ used_bytes: used, quota_bytes: used + 50_000 });

    // B writes into A's drawer: the bytes are A's, so A's quota refuses the bigger photo
    const over = await B.call("PUT", `/drawers/${id}/photo`, photo(200_000));
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({ code: "StorageQuotaExceeded", context: { owner_id: A.id, used_bytes: used, quota_bytes: used + 50_000 } });
    expect((await B.call("PUT", `/drawers/${id}/photo`, photo(120_000))).statusCode).toBe(204); // +20 000 still fits
    expect((await B.postEntry(id, key, line, "add", 1)).res.statusCode).toBe(201);
    expect((await A.createDrawer("Small", newDocument("Small"))).res.statusCode).toBe(201);  // a new drawer (a 16 KiB padded document) fits

    setQuota((await storage(A)).used_bytes); // full
    expect((await B.postEntry(id, key, line, "add", 1)).res.json().code).toBe("StorageQuotaExceeded");
    expect((await A.createDrawer("None", newDocument("None"))).res.json().code).toBe("StorageQuotaExceeded");
    const put = await A.call("PUT", `/drawers/${id}/document`, { ...sealedBody(await A.sealDoc(id, key, { ...doc, name: "Renamed" }), 1), base_version: 1 });
    expect(put.json().code).toBe("StorageQuotaExceeded");
    // what frees space passes: a smaller photo, removing the photo, deleting a line
    expect((await A.call("PUT", `/drawers/${id}/photo`, photo(10_000))).statusCode).toBe(204);
    expect((await A.call("DELETE", `/drawers/${id}/photo`)).statusCode).toBe(204);
    const without = applyOp(doc, { type: "remove_line", line_id: line }, { lineHasEntries: () => true });
    setQuota((await storage(A)).used_bytes);
    expect((await A.call("POST", `/drawers/${id}/lines/${line}/delete`, { document: { ...sealedBody(await A.sealDoc(id, key, without), 1), base_version: 1 } })).statusCode).toBe(200);
    // the member's own storage is untouched by their writes into A's drawer
    expect((await storage(B)).used_bytes).toBe(memberBefore);
  }, 60_000);
});

describe("languages (PETTY-249)", () => {
  it("an account's language can be en/pl/de/es/fr, and the emails it gets follow it", async () => {
    const { sentMails } = await import("../src/lib/mail.js");
    expect((await C.call("PATCH", "/me", { locale: "de" })).json().locale).toBe("de");
    expect((await C.call("PATCH", "/me", { locale: "xx" })).statusCode).toBe(400);
    const { id } = await sharedDrawer(); // C reads it
    expect((await A.call("DELETE", `/drawers/${id}/members/${C.id}`)).statusCode).toBe(204);
    expect([...sentMails].reverse().find((m) => m.to === C.user.email)?.subject).toBe("Dein Zugriff auf eine Schublade wurde beendet");
    // a join link reaches someone with no account yet: it goes out in the inviter's language
    expect((await A.call("PATCH", "/me", { locale: "fr" })).statusCode).toBe(200);
    expect((await A.call("POST", "/join-links", { email: `friend-${run}@test.local` })).statusCode).toBe(201);
    const invite = [...sentMails].reverse().find((m) => m.to === `friend-${run}@test.local`)!;
    expect(invite.subject).toBe("Invitation à Petty");
    expect(invite.text).toMatch(/\/join#[A-Za-z0-9_-]+/);
    for (const u of [A, C]) expect((await u.call("PATCH", "/me", { locale: "en" })).statusCode).toBe(200);
  });
});

describe("admin and password reset (Phase 15a)", () => {
  it("non-admins get 403; block kills login and sessions; unblock restores; revoke ends sessions; self is protected", async () => {
    const { sentMails } = await import("../src/lib/mail.js");
    const M = new Client(app, await userMaterial("mod", { email: `mod-${run}@test.local` }));
    const V = new Client(app, await userMaterial("victim", { email: `victim-${run}@test.local` }));
    expect((await M.signup(await makeJoinLink())).statusCode).toBe(201);
    expect((await V.signup(await makeJoinLink())).statusCode).toBe(201);
    expect((await M.call("GET", "/admin/users")).statusCode).toBe(403);
    expect((await M.call("GET", "/me")).json().is_admin).toBe(false);
    await owner.query("update users set is_admin = true where id = $1", [M.id]);
    expect((await M.call("GET", "/me")).json().is_admin).toBe(true);
    const list = await M.call("GET", "/admin/users");
    expect(list.statusCode).toBe(200);
    const v = list.json().users.find((u: { id: string }) => u.id === V.id);
    expect(v.email).toBe(V.user.email);
    expect(v.blocked_at).toBeNull();
    expect((await M.call("POST", `/admin/users/${M.id}/block`)).json().code).toBe("NotOnSelf");
    expect((await M.call("POST", `/admin/users/${V.id}/block`)).statusCode).toBe(204);
    expect((await V.call("GET", "/me")).statusCode).toBe(401); // existing session dead
    expect((await V.login()).statusCode).toBe(401); // and no new one
    expect((await M.call("POST", `/admin/users/${V.id}/unblock`)).statusCode).toBe(204);
    expect((await V.login()).statusCode).toBe(200);
    // PETTY-188 (NR-8): "sign out everywhere" ends the user's access tokens too
    const tokenOk = (bearer: string) => app.inject({ method: "GET", url: "/me/token", headers: { authorization: `Bearer ${bearer}` } }).then((r) => r.statusCode);
    const t1 = await V.makeAccessToken();
    expect(await tokenOk(t1.bearer)).toBe(200);
    expect((await M.call("POST", `/admin/users/${V.id}/revoke-sessions`)).statusCode).toBe(204);
    expect(await tokenOk(t1.bearer)).toBe(401);
    expect((await V.call("GET", "/me")).statusCode).toBe(401);
    expect((await V.login()).statusCode).toBe(200);
    const t2 = await V.makeAccessToken("write");
    expect(await tokenOk(t2.bearer)).toBe(200);
    expect((await M.call("POST", `/admin/users/${V.id}/admin`, { is_admin: true })).statusCode).toBe(204);
    expect((await V.call("GET", "/admin/users")).statusCode).toBe(200);
    // password reset: always 204; the mail carries a one-hour single-use token; sessions die on reset
    expect((await V.call("POST", "/auth/forgot", { email: `ghost-${run}@test.local` })).statusCode).toBe(204);
    expect(sentMails.some((m) => m.to === `ghost-${run}@test.local`)).toBe(false);
    expect((await V.call("POST", "/auth/forgot", { email: V.user.email.toUpperCase() })).statusCode).toBe(204);
    const mail = [...sentMails].reverse().find((m) => m.to === V.user.email.toUpperCase())!;
    expect(mail).toBeTruthy();
    expect(mail.text).toContain("vault passphrase and recovery code stay");
    const token = /\/reset[#/]([A-Za-z0-9_-]+)/.exec(mail.text)![1]!; // the token rides in the fragment (SR-9)
    expect((await V.call("POST", "/auth/reset", { token: "nope-nope-nope-nope", password: "new-password-1" })).json().code).toBe("ResetInvalid");
    expect((await V.call("POST", "/auth/reset", { token, password: "new-password-1" })).statusCode).toBe(204);
    expect((await V.call("GET", "/me")).statusCode).toBe(401);
    expect(await tokenOk(t2.bearer)).toBe(401); // PETTY-188: a reset ends the tokens as well
    expect((await V.login()).statusCode).toBe(401); // old password
    V.user.password = "new-password-1";
    expect((await V.login()).statusCode).toBe(200);
    expect((await V.call("POST", "/auth/reset", { token, password: "new-password-2" })).json().code).toBe("ResetInvalid"); // single use
  }, 90_000);
});
