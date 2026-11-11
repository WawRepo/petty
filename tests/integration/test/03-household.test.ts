import { beforeAll, describe, expect, it } from "vitest";
import { createDrawerKey, createRecoveryVault, fromB64, generateRecoveryCode, generateUserKeys, openDocument, openEntryUnverified, patSecret, patToken, reseal, sealPatBundle, toB64, unlockVault, wrapDrawerKey, type VaultBlobV1 } from "@petty/crypto";
import { applyOp, fold, newDocument, nextRev, readDocument, type DrawerDocument, type LedgerEntry } from "@petty/ledger";
import { connect } from "@petty/agent";
import { DOCUMENT_MIN_CIPHERTEXT } from "@petty/protocol";
import { sealedBody, type Client } from "../../../apps/api/src/devtools/fixtures.js";
import { API, compose, http, newUser } from "../lib.js";

/**
 * What a household does, end to end, over HTTP against the real image: two people, a shared
 * drawer, entries from both, a mistake undone, and a tool with an access token.
 */
let ann: Client, ben: Client;
let drawerId: string, lineId: string, key: CryptoKey;
let joinToken: string;

async function balance(c: Client): Promise<{ balance: number; entries: number }> {
  const boot = (await c.call("GET", "/bootstrap")).json();
  const list: LedgerEntry[] = [];
  for (const r of boot.entries.filter((e: { drawer_id: string; line_id: string }) => e.drawer_id === drawerId && e.line_id === lineId)) {
    const entry = await openEntryUnverified(key, { record_type: "entry", record_id: r.id, drawer_id: drawerId, line_id: lineId, author_id: r.author_id, key_version: r.key_version, schema_version: r.schema_version }, { nonce: fromB64(r.nonce), ciphertext: fromB64(r.ciphertext) });
    list.push({ seq: r.seq, received_at: r.received_at, entry });
  }
  return { balance: fold(list).balance, entries: list.length };
}

async function documentName(c: Client): Promise<string | null> {
  const got = (await c.call("GET", `/drawers/${drawerId}`)).json();
  const d = got.document;
  try {
    const doc = await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: d.author_id, key_version: d.key_version, schema_version: d.schema_version }, { nonce: fromB64(d.nonce), ciphertext: fromB64(d.ciphertext) });
    return (doc as { name: string }).name;
  } catch { return null; }
}

beforeAll(async () => {
  ann = await newUser("ann");
  // the second person joins with a link the first one made
  const link = await ann.call("POST", "/join-links", {});
  expect(link.statusCode).toBe(201);
  joinToken = link.json().token;
  // PETTY-457: what the sign-up page asks first, with the token in the body
  expect((await http.inject({ method: "POST", url: "/join-links/lookup", headers: { "content-type": "application/json" }, payload: JSON.stringify({ token: joinToken }) })).json()).toEqual({ valid: true, inviter_name: ann.user.display_name, email: null });
  ben = await newUser("ben", joinToken);
});

describe("household", () => {
  it("signs in, logs out, signs in again", async () => {
    expect((await ann.call("GET", "/me")).json().id).toBe(ann.id);
    expect((await ann.call("POST", "/auth/logout")).statusCode).toBe(204);
    expect((await ann.call("GET", "/me")).statusCode).toBe(401);
    expect((await ann.login()).statusCode).toBe(200);
    const wrong = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ann.user.email, password: "not-the-password" }) });
    expect(wrong.status).toBe(401);
  });

  it("takes a changing request from a browser only when the browser marks it same-origin (PETTY-409)", async () => {
    const send = (url: string, site: string | null) => http.inject({ method: "POST", url, cookies: { petty_session: ann.cookie! }, headers: site === null ? {} : { "sec-fetch-site": site } });
    for (const site of ["same-site", "cross-site", "none"]) {
      const res = await send("/auth/logout", site);
      expect(res.statusCode, site).toBe(403);
      expect(res.json().code, site).toBe("CrossSiteRequest");
    }
    expect((await ann.call("GET", "/me")).statusCode).toBe(200); // still signed in
    // the web app's own requests, and a program that sends no such header
    expect((await send("/me/custody-challenge", "same-origin")).statusCode).toBe(200);
    expect((await send("/me/custody-challenge", null)).statusCode).toBe(200);
  });

  it("makes a drawer and adds entries; the balance folds from the log", async () => {
    lineId = crypto.randomUUID();
    const doc = applyOp(newDocument("Kitchen tin"), { type: "add_line", line: { id: lineId, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const d = await ann.createDrawer("Kitchen tin", doc);
    expect(d.res.statusCode).toBe(201);
    drawerId = d.id;
    key = d.key;
    expect((await ann.postEntry(drawerId, key, lineId, "add", 5000)).res.statusCode).toBe(201);
    expect((await ann.postEntry(drawerId, key, lineId, "withdraw", -1250)).res.statusCode).toBe(201);
    expect(await balance(ann)).toEqual({ balance: 3750, entries: 2 });
  });

  it("finds the other person by email in a POST body; no address reaches the request log (PETTY-408)", async () => {
    const found = await ann.call("POST", "/users/lookup", { email: ben.user.email.toUpperCase() });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ id: ben.id, keys: { ecdh_pub: ben.user.pub.ecdh } });
    expect((await ann.call("POST", "/users/lookup", { email: `nobody-${ben.id}@petty.test` })).statusCode).toBe(404);
    const lines = () => compose("logs --no-color --no-log-prefix app").split("\n").filter((l) => l.includes('"msg":"request"') && l.includes("/users/lookup"));
    await expect.poll(() => lines().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(lines().join("\n")).not.toContain("email=");
    expect(lines().join("\n")).not.toContain(ben.user.email);
  });

  it("no address or join token travels in a URL; a program that still asks that way gets 404 and leaves neither in the log (PETTY-457)", async () => {
    const used = await http.inject({ method: "POST", url: "/join-links/lookup", headers: { "content-type": "application/json" }, payload: JSON.stringify({ token: joinToken }) });
    expect(used.json()).toEqual({ valid: false, inviter_name: null, email: null }); // ben signed up with it
    const fresh = (await ann.call("POST", "/join-links", {})).json().token as string;
    const probe = `probe-${ben.id}@petty.test`;
    // what a web app from before the change sends
    expect((await ann.call("GET", `/join-links/${fresh}`)).statusCode).toBe(404);
    expect((await ann.call("GET", `/users/lookup?email=${encodeURIComponent(probe)}`)).statusCode).toBe(404);
    expect((await http.inject({ method: "POST", url: "/join-links/lookup", headers: { "content-type": "application/json" }, payload: JSON.stringify({ token: fresh }) })).json().valid).toBe(true);
    const log = () => compose("logs --no-color --no-log-prefix app").split("\n").filter((l) => l.includes('"msg":"request"'));
    await expect.poll(() => log().filter((l) => l.includes("/api/join-links/lookup")).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    const all = log().join("\n");
    for (const secret of [fresh, joinToken, probe, encodeURIComponent(probe), "email="]) expect(all).not.toContain(secret);
  });

  it("shares the drawer; the other person reads and writes; a stranger cannot", async () => {
    const wrap = (await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
    const raw = await ann.unwrap(wrap, ann.user.pub.ecdh, true);
    const inv = await ann.call("POST", `/drawers/${drawerId}/invitations`, { invitee_id: ben.id, role: "write", wrap: await ann.wrapFor(raw, ben.user.pub.ecdh, drawerId, 1) });
    expect(inv.statusCode).toBe(201);
    expect((await ben.call("POST", `/invitations/${inv.json().id}/accept`)).statusCode).toBe(204);
    expect((await ben.postEntry(drawerId, key, lineId, "add", 250)).res.statusCode).toBe(201);
    expect(await balance(ann)).toEqual({ balance: 4000, entries: 3 });
    expect(await balance(ben)).toEqual({ balance: 4000, entries: 3 });
    const stranger = await newUser("stranger");
    expect((await stranger.call("GET", `/drawers/${drawerId}`)).statusCode).toBe(404);
  });

  it("the owner sees a drawer's pending invitations, and they end when the drawer gets a new owner (PETTY-446)", async () => {
    const shed = await ann.createDrawer("Shed");
    expect(shed.res.statusCode).toBe(201);
    const raw = await ann.unwrap((await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === shed.id), ann.user.pub.ecdh, true);
    const invite = async (from: Client, to: Client) => from.call("POST", `/drawers/${shed.id}/invitations`, { invitee_id: to.id, role: "write", wrap: await from.wrapFor(raw, to.user.pub.ecdh, shed.id, 1) });
    const first = await invite(ann, ben);
    expect(first.statusCode).toBe(201);
    expect((await ben.call("POST", `/invitations/${first.json().id}/accept`)).statusCode).toBe(204);
    const cat = await newUser("cat");
    const pending = await invite(ann, cat);
    expect(pending.statusCode).toBe(201);
    const listed = (await ann.call("GET", `/drawers/${shed.id}/invitations`)).json().invitations as { id: string; invitee: { id: string } }[];
    expect(listed.map((i) => [i.id, i.invitee.id])).toEqual([[pending.json().id, cat.id]]);
    expect((await ben.call("GET", `/drawers/${shed.id}/invitations`)).statusCode).toBe(403); // a member, not the owner
    // ann hands the drawer to ben: what she left open is over
    expect((await ann.call("POST", `/drawers/${shed.id}/transfer`, { to_user_id: ben.id })).statusCode).toBe(201);
    expect((await ben.call("POST", `/drawers/${shed.id}/transfer/accept`)).statusCode).toBe(204);
    expect((await cat.call("POST", `/invitations/${pending.json().id}/accept`)).statusCode).toBe(404);
    expect((await cat.call("GET", `/drawers/${shed.id}`)).statusCode).toBe(404);
    expect((await ben.call("GET", `/drawers/${shed.id}/invitations`)).json()).toEqual({ invitations: [] });
    // the new owner invites again, and only he can take it back
    const again = await invite(ben, cat);
    expect(again.statusCode).toBe(201);
    expect((await ann.call("DELETE", `/invitations/${again.json().id}`)).statusCode).toBe(404);
    expect((await ben.call("DELETE", `/invitations/${again.json().id}`)).statusCode).toBe(204);
    // ann leaves, so the later steps see her drawers as before
    expect((await ann.call("POST", `/drawers/${shed.id}/leave`)).statusCode).toBe(204);
  });

  it("an Adjust sets what was counted, and later entries fold on top of it", async () => {
    const head = (await ann.call("GET", "/bootstrap")).json().entries.filter((e: { line_id: string }) => e.line_id === lineId).reduce((m: number, e: { seq: number }) => Math.max(m, e.seq), 0);
    expect((await ann.postEntry(drawerId, key, lineId, "adjust", 3900, { expected_head_seq: head, delta_hint: -100 })).res.statusCode).toBe(201);
    expect((await ben.postEntry(drawerId, key, lineId, "add", 100)).res.statusCode).toBe(201);
    expect((await balance(ann)).balance).toBe(4000);
  });

  it("a broken document can be put back by the owner: the client saves the kept copy with a counter inside (PETTY-183, PETTY-422)", async () => {
    const got = (await ann.call("GET", `/drawers/${drawerId}`)).json();
    const junk = { base_version: got.drawer.version, key_version: 1, schema_version: 1, nonce: toB64(crypto.getRandomValues(new Uint8Array(12))), ciphertext: toB64(crypto.getRandomValues(new Uint8Array(DOCUMENT_MIN_CIPHERTEXT))), verification: false };
    expect((await ben.call("PUT", `/drawers/${drawerId}/document`, junk)).statusCode).toBe(200);
    expect(await documentName(ann)).toBeNull();
    const [last] = (await ann.call("GET", `/drawers/${drawerId}/document/history`)).json().history;
    const now = (await ann.call("GET", `/drawers/${drawerId}`)).json().drawer.version;
    // PETTY-422: the server copies nothing back any more; a web app from before the change is told to update
    const byServer = await ann.call("POST", `/drawers/${drawerId}/document/restore`, { history_id: last.id, base_version: now });
    expect(byServer.statusCode).toBe(410);
    expect(byServer.json().code).toBe("RestoreByApp");
    expect(await documentName(ann)).toBeNull();
    // what the owner's app does: open the kept copy (from before the counter: format 1, none inside) and save it as format 2 with its first counter
    const h = last.document;
    expect(h.schema_version).toBe(1);
    const kept = readDocument(await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: h.author_id, key_version: h.key_version, schema_version: h.schema_version }, { nonce: fromB64(h.nonce), ciphertext: fromB64(h.ciphertext) }), { schema_version: h.schema_version, version: last.version });
    expect(kept.rev).toBeUndefined();
    expect((await ann.call("PUT", `/drawers/${drawerId}/document`, { ...sealedBody(await ann.sealDoc(drawerId, key, nextRev(kept), 1, 2), 1, 2), base_version: now, verification: false })).statusCode).toBe(200);
    expect(await documentName(ann)).toBe("Kitchen tin");
    expect((await ann.call("GET", `/drawers/${drawerId}`)).json().document.schema_version).toBe(2);
    // a client from before the counter cannot put a document without one over it
    const older = await ben.call("PUT", `/drawers/${drawerId}/document`, { ...sealedBody(await ben.sealDoc(drawerId, key, kept, 1, 1), 1, 1), base_version: now + 1, verification: false });
    expect(older.statusCode).toBe(409);
    expect(older.json().code).toBe("DocumentFormatOlder");
    // PETTY-403: a restore is a new version, not the old number again: the web app refuses a drawer older than one it opened
    expect((await ann.call("GET", `/drawers/${drawerId}`)).json().drawer.version).toBe(now + 1);
    // PETTY-194: the list the app shows — newest first, the undone version kept too, members cannot read it
    const after = (await ann.call("GET", `/drawers/${drawerId}/document/history`)).json().history as { id: string; by_token: boolean; replaced_at: string }[];
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after.map((h) => h.replaced_at)).toEqual([...after.map((h) => h.replaced_at)].sort().reverse());
    expect((await ben.call("GET", `/drawers/${drawerId}/document/history`)).statusCode).toBe(403);
  });

  it("deleting a drawer needs a custody proof, not just an owner session (PETTY-201)", async () => {
    const doomed = await ann.createDrawer("Doomed");
    expect(doomed.res.statusCode).toBe(201);
    expect((await ann.call("DELETE", `/drawers/${doomed.id}`)).statusCode).toBe(400);
    expect((await ann.call("DELETE", `/drawers/${doomed.id}`, { proof: await ann.proof() })).statusCode).toBe(204);
    expect((await ann.call("GET", `/drawers/${doomed.id}`)).statusCode).toBe(404);
  });

  it("a new drawer key and deleting a line need a custody proof; a request without one changes nothing (PETTY-440, PETTY-441)", async () => {
    const line = crypto.randomUUID();
    const doc = applyOp(newDocument("Spare tin"), { type: "add_line", line: { id: line, kind: "money", name: "Cash", currency: "PLN", exponent: 2 } }, { lineHasEntries: () => false });
    const d = await ann.createDrawer("Spare tin", doc);
    expect(d.res.statusCode).toBe(201);
    expect((await ann.postEntry(d.id, d.key, line, "add", 700)).res.statusCode).toBe(201);
    expect((await ann.postEntry(d.id, d.key, line, "add", 300)).res.statusCode).toBe(201);
    const exported = async () => (await ann.call("GET", `/drawers/${d.id}/export`)).json() as { drawer: { key_version: number; version: number }; document: { author_id: string; nonce: string; ciphertext: string; key_version: number }; entries: { id: string; line_id: string; author_id: string; nonce: string; ciphertext: string; key_version: number }[] };
    const start = await exported();

    // the next key, made and wrapped the way the web app does it
    const { key: key2, selfWrap } = await createDrawerKey(ann.sender, d.id, 2);
    const wraps = [{ user_id: ann.id, wrap: selfWrap }];
    // as a web app from before this change sends it: refused, and the drawer keeps its key
    const oldStart = await ann.call("POST", `/drawers/${d.id}/rotation`, { to_version: 2, wraps });
    expect(oldStart.statusCode).toBe(403);
    expect(oldStart.json().code).toBe("CustodyProofRequired");
    expect(await exported()).toEqual(start);
    // a proof signed with a key that is not the account's
    const foreign = await ann.call("POST", `/drawers/${d.id}/rotation`, { to_version: 2, wraps, proof: await ann.proof(ben.user.keys.ecdsa.privateKey) });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().code).toBe("CustodyProofInvalid");
    expect((await ann.call("POST", `/drawers/${d.id}/rotation`, { to_version: 2, wraps, proof: await ann.proof() })).statusCode).toBe(201);

    const pending = await exported();
    expect(pending.drawer.key_version).toBe(2);
    const entries = [];
    for (const r of pending.entries) {
      const sealed = (await reseal(d.key, key2, { record_type: "entry", record_id: r.id, drawer_id: d.id, line_id: r.line_id, author_id: r.author_id, key_version: r.key_version, schema_version: 1 }, { nonce: fromB64(r.nonce), ciphertext: fromB64(r.ciphertext) }, 2)).sealed;
      entries.push({ id: r.id, nonce: toB64(sealed.nonce), ciphertext: toB64(sealed.ciphertext) });
    }
    const opened = await openDocument(d.key, { record_type: "document", record_id: d.id, drawer_id: d.id, line_id: null, author_id: pending.document.author_id, key_version: 1, schema_version: 1 }, { nonce: fromB64(pending.document.nonce), ciphertext: fromB64(pending.document.ciphertext) });
    const sealedDoc = await ann.sealDoc(d.id, key2, opened as DrawerDocument, 2);
    const batch = { to_version: 2, entries, document: { key_version: 2, schema_version: 1, nonce: toB64(sealedDoc.nonce), ciphertext: toB64(sealedDoc.ciphertext) } };
    // a batch without a proof: refused, every row stays as it was, and the rotation waits
    const oldBatch = await ann.call("PUT", `/drawers/${d.id}/rotation/batch`, batch);
    expect(oldBatch.statusCode).toBe(403);
    expect(oldBatch.json().code).toBe("CustodyProofRequired");
    expect(await exported()).toEqual(pending);
    expect((await ann.call("GET", `/drawers/${d.id}/rotation`)).json()).toMatchObject({ pending_entries: 2, document_pending: true, completed: false });
    const done = await ann.call("PUT", `/drawers/${d.id}/rotation/batch`, { ...batch, proof: await ann.proof() });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ pending_entries: 0, document_pending: false, completed: true });
    // the re-sealed rows open under the new key and hold what was written
    const after = await exported();
    const amounts = [];
    for (const r of after.entries) amounts.push((await openEntryUnverified(key2, { record_type: "entry", record_id: r.id, drawer_id: d.id, line_id: r.line_id, author_id: r.author_id, key_version: 2, schema_version: 1 }, { nonce: fromB64(r.nonce), ciphertext: fromB64(r.ciphertext) })).amount);
    expect(amounts).toEqual([700, 300]);

    // deleting the line: the same rule
    const without = applyOp(opened as DrawerDocument, { type: "remove_line", line_id: line }, { lineHasEntries: () => true });
    const sealedWithout = await ann.sealDoc(d.id, key2, without, 2);
    const body = { document: { key_version: 2, schema_version: 1, nonce: toB64(sealedWithout.nonce), ciphertext: toB64(sealedWithout.ciphertext), base_version: after.drawer.version } };
    const oldDelete = await ann.call("POST", `/drawers/${d.id}/lines/${line}/delete`, body);
    expect(oldDelete.statusCode).toBe(403);
    expect(oldDelete.json().code).toBe("CustodyProofRequired");
    expect(await exported()).toEqual(after);
    const deleted = await ann.call("POST", `/drawers/${d.id}/lines/${line}/delete`, { ...body, proof: await ann.proof() });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deleted_entries).toBe(2);
    expect((await exported()).entries).toEqual([]);
  });

  it("a new recovery code replaces only the recovery copy, and only with proof of the keys (PETTY-200)", async () => {
    const code = generateRecoveryCode();
    const vault = await createRecoveryVault(code, ann.user.keys);
    expect((await ann.call("PUT", "/me/recovery-vault", { password: ann.user.password, recovery_vault: vault })).statusCode).toBe(400); // no proof
    const other = await createRecoveryVault(generateRecoveryCode(), await generateUserKeys());
    expect((await ann.call("PUT", "/me/recovery-vault", { password: ann.user.password, proof: await ann.proof(), recovery_vault: other })).json().code).toBe("KeysMismatch");
    expect((await ann.call("PUT", "/me/recovery-vault", { password: "wrong-password", proof: await ann.proof(), recovery_vault: vault })).statusCode).toBe(401);
    expect((await ann.call("PUT", "/me/recovery-vault", { password: ann.user.password, proof: await ann.proof(), recovery_vault: vault })).statusCode).toBe(204);
    const stored = (await ann.call("GET", "/me/recovery-vault")).json().recovery_vault as VaultBlobV1;
    await expect(unlockVault(stored, code)).resolves.toBeTruthy();
    await expect(unlockVault(stored, ann.user.recovery_code)).rejects.toThrow();
    expect((await ann.call("GET", "/me")).json().vault).toBeTruthy(); // the passphrase copy is untouched
  });

  it("a tool with an access token reads and writes through the agent, and stops when revoked", async () => {
    const wrap = (await ann.call("GET", "/bootstrap")).json().wraps.find((w: { drawer_id: string }) => w.drawer_id === drawerId);
    const raw = toB64(new Uint8Array(await crypto.subtle.exportKey("raw", await ann.unwrap(wrap, ann.user.pub.ecdh, true))));
    const tok = await ann.makeAccessToken("write", [{ drawer_id: drawerId, key_version: 1, key: raw }]);
    expect(tok.res.statusCode).toBe(201);
    const bearer = { authorization: `Bearer ${tok.bearer}` };
    // a token never reaches the vault (PETTY-182)
    expect((await fetch(`${API}/bootstrap`, { headers: bearer })).status).toBe(403);
    expect((await fetch(`${API}/me`, { headers: bearer })).status).toBe(403);

    const agent = await connect({ token: tok.token, apiUrl: API });
    const line = (await agent.drawers()).find((d) => d.id === drawerId)!.lines[0]!;
    expect(line.amount).toBe("40.00 PLN");
    expect(line.unverified).toBe(0); // every entry, from both people, checks out (PETTY-191)
    const res = await agent.add(drawerId, lineId, "1.00", "from the tool");
    expect(res.balanceAfter).toBe("41.00 PLN");
    const history = await agent.history(drawerId, lineId);
    expect(history[0]).toMatchObject({ comment: "from the tool", amount: "1.00 PLN", verified: true });
    expect((await balance(ann)).balance).toBe(4100);

    // PETTY-339: the tool undoes its entry; the owner's own fold cancels it, and the log keeps both
    const undone = await agent.undo(drawerId, lineId, res.id, "typo");
    expect(undone.balanceAfter).toBe("40.00 PLN");
    expect((await balance(ann)).balance).toBe(4000);
    expect((await agent.history(drawerId, lineId)).slice(0, 2).map((e) => [e.op, e.verified])).toEqual([["reverse", true], ["add", true]]);

    // PETTY-336: the tool adds a new item, and the other member's app opens it with its first entry
    const made = await agent.addItem(drawerId, { kind: "countable", name: "Stamps", unit: "pcs", start: "20" });
    expect(made.line).toMatchObject({ name: "Stamps", balance: 20, unverified: 0 });
    // PETTY-351: a count shown as "1,000" can be typed back
    expect((await agent.adjust(drawerId, made.line.id, "1,000", "counted")).balanceAfter).toBe("1,000");
    const got = (await ben.call("GET", `/drawers/${drawerId}`)).json();
    const doc = await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: got.document.author_id, key_version: got.document.key_version, schema_version: got.document.schema_version }, { nonce: fromB64(got.document.nonce), ciphertext: fromB64(got.document.ciphertext) }) as { lines: { id: string }[] };
    expect(doc.lines.find((l) => l.id === made.line.id)).toMatchObject({ kind: "countable", name: "Stamps", unit: "pcs" });
    // PETTY-339: and changes it; the other member's app opens the change
    await agent.editItem(drawerId, made.line.id, { name: "Postage stamps", unit: "sheets" });
    const got2 = (await ben.call("GET", `/drawers/${drawerId}`)).json();
    const doc2 = await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: got2.document.author_id, key_version: got2.document.key_version, schema_version: got2.document.schema_version }, { nonce: fromB64(got2.document.nonce), ciphertext: fromB64(got2.document.ciphertext) }) as { rev: number; lines: { id: string }[] };
    expect(doc2.lines.find((l) => l.id === made.line.id)).toMatchObject({ name: "Postage stamps", unit: "sheets" });
    // PETTY-422: the document has had a counter since the owner put it back; each of the tool's two saves added one and kept the format
    expect(got2.document.schema_version).toBe(2);
    expect(doc2.rev).toBe((doc as unknown as { rev: number }).rev + 1);
    expect(readDocument(doc2, { schema_version: 2, version: got2.drawer.version }).rev).toBe(3);
    expect((await ben.call("GET", "/bootstrap")).json().entries.filter((e: { line_id: string }) => e.line_id === made.line.id)).toHaveLength(1);

    expect((await ann.call("DELETE", `/me/tokens/${tok.rowId}`)).statusCode).toBe(204);
    await expect(agent.drawers()).rejects.toMatchObject({ code: "TokenRevoked" });
  });

  it("a token's drawer keys sent in several requests all reach the tool (PETTY-372)", async () => {
    // The web app sends a token's wraps in batches: each request adds to the last, and a repeat changes nothing.
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
    const pub = toB64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    const id = toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "_");
    const secret = patSecret();
    const bundle = await sealPatBundle(secret, id, { v: 1, user_id: ann.id, drawers: [], ecdh: toB64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))), owner_ecdh: ann.user.pub.ecdh });
    const made = await ann.call("POST", "/me/tokens", { token_id: id, ecdh_pub: pub, name: "Batches", role: "read", scope: null, expires_at: null, bundle, proof: await ann.proof() });
    expect(made.statusCode).toBe(201);
    const rowId = made.json().id as string;

    const attic = await ann.createDrawer("Attic");
    expect(attic.res.statusCode).toBe(201);
    const wraps = (await ann.call("GET", "/bootstrap")).json().wraps;
    const forToken = async (drawer: string) => ({ drawer_id: drawer, key_version: 1, wrap: await wrapDrawerKey(await ann.unwrap(wraps.find((w: { drawer_id: string }) => w.drawer_id === drawer), ann.user.pub.ecdh, true), ann.sender, pub, drawer, 1) });
    const first = await forToken(drawerId);
    for (const keys of [[first], [await forToken(attic.id)], [first]]) {
      expect((await ann.call("POST", `/me/tokens/${rowId}/keys`, { keys })).statusCode).toBe(204);
    }
    const agent = await connect({ token: patToken(id, secret), apiUrl: API });
    expect((await agent.drawers()).map((d) => d.id).sort()).toEqual([drawerId, attic.id].sort());
    expect((await ann.call("DELETE", `/me/tokens/${rowId}`)).statusCode).toBe(204);
  });
});
