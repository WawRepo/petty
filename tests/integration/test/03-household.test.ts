import { beforeAll, describe, expect, it } from "vitest";
import { createRecoveryVault, fromB64, generateRecoveryCode, generateUserKeys, openDocument, openEntryUnverified, toB64, unlockVault, type VaultBlobV1 } from "@petty/crypto";
import { applyOp, fold, newDocument, type LedgerEntry } from "@petty/ledger";
import { connect } from "@petty/agent";
import type { Client } from "../../../apps/api/src/devtools/fixtures.js";
import { API, newUser } from "../lib.js";

/**
 * What a household does, end to end, over HTTP against the real image: two people, a shared
 * drawer, entries from both, a mistake undone, and a tool with an access token.
 */
let ann: Client, ben: Client;
let drawerId: string, lineId: string, key: CryptoKey;

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
  ben = await newUser("ben", link.json().token);
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

  it("an Adjust sets what was counted, and later entries fold on top of it", async () => {
    const head = (await ann.call("GET", "/bootstrap")).json().entries.filter((e: { line_id: string }) => e.line_id === lineId).reduce((m: number, e: { seq: number }) => Math.max(m, e.seq), 0);
    expect((await ann.postEntry(drawerId, key, lineId, "adjust", 3900, { expected_head_seq: head, delta_hint: -100 })).res.statusCode).toBe(201);
    expect((await ben.postEntry(drawerId, key, lineId, "add", 100)).res.statusCode).toBe(201);
    expect((await balance(ann)).balance).toBe(4000);
  });

  it("a broken document can be put back by the owner (PETTY-183)", async () => {
    const got = (await ann.call("GET", `/drawers/${drawerId}`)).json();
    const junk = { base_version: got.drawer.version, key_version: 1, schema_version: 1, nonce: toB64(crypto.getRandomValues(new Uint8Array(12))), ciphertext: toB64(crypto.getRandomValues(new Uint8Array(40))), verification: false };
    expect((await ben.call("PUT", `/drawers/${drawerId}/document`, junk)).statusCode).toBe(200);
    expect(await documentName(ann)).toBeNull();
    const [last] = (await ann.call("GET", `/drawers/${drawerId}/document/history`)).json().history;
    const now = (await ann.call("GET", `/drawers/${drawerId}`)).json().drawer.version;
    expect((await ann.call("POST", `/drawers/${drawerId}/document/restore`, { history_id: last.id, base_version: now })).statusCode).toBe(200);
    expect(await documentName(ann)).toBe("Kitchen tin");
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

    // PETTY-336: the tool adds a new item, and the other member's app opens it with its first entry
    const made = await agent.addItem(drawerId, { kind: "countable", name: "Stamps", unit: "pcs", start: "20" });
    expect(made.line).toMatchObject({ name: "Stamps", balance: 20, unverified: 0 });
    const got = (await ben.call("GET", `/drawers/${drawerId}`)).json();
    const doc = await openDocument(key, { record_type: "document", record_id: drawerId, drawer_id: drawerId, line_id: null, author_id: got.document.author_id, key_version: got.document.key_version, schema_version: got.document.schema_version }, { nonce: fromB64(got.document.nonce), ciphertext: fromB64(got.document.ciphertext) }) as { lines: { id: string }[] };
    expect(doc.lines.find((l) => l.id === made.line.id)).toMatchObject({ kind: "countable", name: "Stamps", unit: "pcs" });
    expect((await ben.call("GET", "/bootstrap")).json().entries.filter((e: { line_id: string }) => e.line_id === made.line.id)).toHaveLength(1);

    expect((await ann.call("DELETE", `/me/tokens/${tok.rowId}`)).statusCode).toBe(204);
    await expect(agent.drawers()).rejects.toMatchObject({ code: "TokenRevoked" });
  });
});
