import { randomBytes, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { exportPublicKeys, fromB64, generateUserKeys, hashEntry, openEntryUnverified, sealEntry, signDelegation, signEntry, signingKeyId, toB64, unwrapDrawerKey, type DrawerKeyWrapV1, type EntryPayloadV1 } from "@petty/crypto";
import { acceptViaUi, apiClient, dbQuery, expect, inviteViaUi, loginAndUnlock, makeDrawer, openSettings, readUserDoc, rowNamed, shareViaApi, signupWithKeys, test, type TestUserWithKeys } from "./fixtures.js";

/**
 * PETTY-413: an entry counts as its author's only when it is signed with a key the reader holds for that author: the
 * reader's own key, or one pinned for the author in the reader's sealed user document. The server's list of an
 * author's keys decides nothing for an author who is pinned.
 */

interface Row { id: string; drawer_id: string; line_id: string; seq: number; author_id: string; key_version: number; nonce: string; ciphertext: string }
interface Boot { wraps: Array<DrawerKeyWrapV1 & { sender_id?: string }>; entries: Row[] }
interface Signer { privateKey: CryptoKey; sigKeyId: string }

/** A drawer as one of its members holds it outside the browser: its current key, its one item, and the newest entry there. */
async function drawerOf(member: TestUserWithKeys, drawerId: string, wrappedBy: TestUserWithKeys) {
  const api = await apiClient(member);
  const boot = (await api.call("GET", "/bootstrap")).json as Boot;
  const wrap = boot.wraps.filter((w) => w.drawer_id === drawerId).at(-1)!;
  const key = await unwrapDrawerKey(wrap, member.keys.ecdh.privateKey, { drawer_id: drawerId, key_version: wrap.key_version, senderEcdhPublicB64: wrappedBy.ecdhPub });
  const last = boot.entries.filter((e) => e.drawer_id === drawerId).at(-1)!;
  const head = await openEntryUnverified(key, { record_type: "entry", record_id: last.id, drawer_id: drawerId, line_id: last.line_id, author_id: last.author_id, key_version: last.key_version, schema_version: 1 }, { nonce: fromB64(last.nonce), ciphertext: fromB64(last.ciphertext) });
  return { api, drawerId, key, keyVersion: wrap.key_version, lineId: last.line_id, prevHash: await hashEntry(head) };
}
type Held = Awaited<ReturnType<typeof drawerOf>>;

/** An "add" of `amount` (minor units) that names `authorId` as its author, linked to the entry before it, signed by `signer` and sealed with the drawer key. */
async function sealedAdd(d: Held, authorId: string, signer: Signer, amount: number, prevHash = d.prevHash) {
  const payload: EntryPayloadV1 = {
    v: 1, id: randomUUID(), drawer_id: d.drawerId, line_id: d.lineId, op: "add", amount, exponent: 2, comment: "", logged_at: new Date().toISOString(),
    reverses: null, prev_hash: prevHash, delta_hint: null, author_id: authorId, sig_key_id: signer.sigKeyId,
  };
  const signed = await signEntry(payload, signer.privateKey);
  const sealed = await sealEntry(d.key, { record_type: "entry", record_id: payload.id, drawer_id: d.drawerId, line_id: d.lineId, author_id: authorId, key_version: d.keyVersion, schema_version: 1 }, signed);
  return { id: payload.id, nonce: sealed.nonce, ciphertext: sealed.ciphertext, hash: await hashEntry(signed) };
}

/** The entry sent by its author's own session, as the app sends it. */
async function post(d: Held, e: Awaited<ReturnType<typeof sealedAdd>>): Promise<void> {
  const r = await d.api.call("POST", `/drawers/${d.drawerId}/entries`, { id: e.id, line_id: d.lineId, is_checkpoint: false, reverses_entry_id: null, key_version: d.keyVersion, schema_version: 1, nonce: toB64(e.nonce), ciphertext: toB64(e.ciphertext) });
  expect(r.status).toBe(201);
}
/** The entry as a row put straight into the database, under any author. */
async function insert(d: Held, authorId: string, e: Awaited<ReturnType<typeof sealedAdd>>): Promise<void> {
  await dbQuery(
    `insert into entries (id, drawer_id, line_id, seq, author_id, is_checkpoint, key_version, schema_version, nonce, ciphertext)
     select $1, $2, $3, max(seq) + 1, $4, false, $5, 1, $6, $7 from entries where drawer_id = $2 and line_id = $3`,
    [e.id, d.drawerId, d.lineId, authorId, d.keyVersion, Buffer.from(e.nonce), Buffer.from(e.ciphertext)],
  );
  await dbQuery("update line_heads set head_seq = head_seq + 1 where drawer_id = $1 and line_id = $2", [d.drawerId, d.lineId]);
}
/** A fresh signing key, as anyone can make one. */
async function newSigner(): Promise<Signer & { pub: { ecdh: string; ecdsa: string } }> {
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  return { privateKey: keys.ecdsa.privateKey, sigKeyId: await signingKeyId(pub.ecdsa), pub };
}
const signerOf = async (u: TestUserWithKeys): Promise<Signer> => ({ privateKey: u.keys.ecdsa.privateKey, sigKeyId: await signingKeyId((await exportPublicKeys(u.keys)).ecdsa) });

async function openCash(page: Page, drawerId: string): Promise<void> {
  await page.goto(`/drawers/${drawerId}`);
  await rowNamed(page, "Cash").click();
  await expect(page.getByTestId("line-balance")).toBeVisible();
}

test("PETTY-413: an entry counts as its author's only under a signing key the reader pinned for them, also when a tool's key signed it; a key the server lists for the author is not enough", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxC = await browser.newContext(); const pageC = await ctxC.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, carol, "write");
  await shareViaApi(alice, id, bob, "read");
  await loginAndUnlock(pageC, carol);
  await acceptViaUi(pageC); // carol confirmed alice's safety number
  const aliceId = (await apiClient(alice)).id;
  // bob reads the drawer, so he holds its key. The database lists two more keys as alice's, both retired; none of them is hers.
  const d = await drawerOf(bob, id, alice);
  const other = await newSigner();
  const voucher = await newSigner();
  const tool = await newSigner();
  for (const k of [other, voucher]) await dbQuery("insert into user_keys (user_id, ecdh_pub, ecdsa_pub, sig_key_id, retired_at) values ($1, $2, $3, $4, now())", [aliceId, k.pub.ecdh, k.pub.ecdsa, k.sigKeyId]);
  // an entry under alice's name signed with the first key
  const first = await sealedAdd(d, aliceId, other, 5000);
  await insert(d, aliceId, first);
  // and one signed by a tool's key, which the second key vouches for
  const delegation = await signDelegation(voucher.privateKey, { user_id: aliceId, account_sig_key_id: voucher.sigKeyId, token_ecdsa_pub: tool.pub.ecdsa, created_at: new Date().toISOString(), expires_at: null });
  await dbQuery("insert into access_tokens (user_id, name, token_hash, role, bundle_nonce, bundle_ciphertext, ecdsa_pub, sig_key_id, delegation) values ($1, 'tool', $2, 'write', 'AAAA', 'AAAA', $3, $4, $5)",
    [aliceId, randomBytes(32), tool.pub.ecdsa, tool.sigKeyId, JSON.stringify(delegation)]);
  await insert(d, aliceId, await sealedAdd(d, aliceId, tool, 7000, first.hash));
  // carol pinned alice: neither entry is alice's, and neither moves the balance. Alice's own app says the same from her vault's key.
  for (const page of [pageC, pageA]) {
    await openCash(page, id);
    await expect(page.getByTestId("warn-problems")).toContainText("2 entries could not be read or verified");
    await expect(page.getByTestId("line-balance")).toHaveText("100.00");
    await expect(page.getByTestId("entry-row")).toHaveCount(1);
  }
  await ctxA.close(); await ctxC.close();
});

test("PETTY-413: entries of someone who deleted their account still verify for a member who pinned them; someone who joins later sees them counted and marked as not confirmed", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxC = await browser.newContext(); const pageC = await ctxC.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write"); // alice compares bob's safety number: his keys are pinned
  const bobApi = await apiClient(bob);
  const inv = ((await bobApi.call("GET", "/invitations")).json as { invitations: Array<{ id: string }> }).invitations[0]!;
  expect((await bobApi.call("POST", `/invitations/${inv.id}/accept`)).status).toBe(204);
  // bob adds 7.00 with his own key, then deletes his account: he is in no drawer any more and his key is retired
  const d = await drawerOf(bob, id, alice);
  await post(d, await sealedAdd(d, bobApi.id, await signerOf(bob), 700));
  expect((await bobApi.call("POST", "/me/delete", { password: bob.password, proof: await bobApi.proof(bob.keys), decisions: [] })).status).toBe(204);
  // alice still holds bob's key in her pins: his entry is his
  await openCash(pageA, id);
  await expect(pageA.getByTestId("line-balance")).toHaveText("107.00");
  await expect(pageA.getByTestId("entry-row")).toHaveCount(2);
  await expect(pageA.getByTestId("warn-problems")).toHaveCount(0);
  await expect(pageA.getByTestId("warn-unconfirmed")).toHaveCount(0);
  // the key was replaced when bob went; carol joins after that and never saw bob
  const aliceApi = await apiClient(alice);
  await expect.poll(async () => (await aliceApi.call("GET", `/drawers/${id}/rotation`)).json, { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  await pageA.goto("/");
  await inviteViaUi(pageA, id, carol, "write");
  await loginAndUnlock(pageC, carol);
  await acceptViaUi(pageC);
  await openCash(pageC, id);
  await expect(pageC.getByTestId("line-balance")).toHaveText("107.00");
  await expect(pageC.getByTestId("entry-row")).toHaveCount(2);
  await expect(pageC.getByTestId("warn-problems")).toHaveCount(0);
  await expect(pageC.getByTestId("warn-unconfirmed")).toContainText("1 entry is from someone who is not in your list of trusted keys");
  await expect(pageC.locator('[data-testid="entry-row"][data-unconfirmed]')).toHaveCount(1);
  await expect(pageC.locator('[data-testid="entry-row"][data-unconfirmed]')).toContainText("author not confirmed");
  await ctxA.close(); await ctxC.close();
});

test("PETTY-413: after a key change is accepted, entries signed with the key confirmed before still verify; before that, an entry signed with the new key is not taken", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  const bobApi = await apiClient(bob);
  const inv = ((await bobApi.call("GET", "/invitations")).json as { invitations: Array<{ id: string }> }).invitations[0]!;
  expect((await bobApi.call("POST", `/invitations/${inv.id}/accept`)).status).toBe(204);
  const d = await drawerOf(bob, id, alice);
  const withOld = await sealedAdd(d, bobApi.id, await signerOf(bob), 700);
  await post(d, withOld);
  // the server now lists another key as bob's current one, and an entry signed with it arrives under his name
  const next = await newSigner();
  await dbQuery("update user_keys set retired_at = now() where user_id = $1", [bobApi.id]);
  await dbQuery("insert into user_keys (user_id, ecdh_pub, ecdsa_pub, sig_key_id) values ($1, $2, $3, $4)", [bobApi.id, next.pub.ecdh, next.pub.ecdsa, next.sigKeyId]);
  await post(d, await sealedAdd(d, bobApi.id, next, 300, withOld.hash));
  await openCash(pageA, id);
  await expect(pageA.getByTestId("warn-problems")).toContainText("1 entry could not be read or verified");
  await expect(pageA.getByTestId("line-balance")).toHaveText("107.00");
  // alice compares the new safety number and accepts the key: both keys are bob's from now on
  await pageA.goto(`/drawers/${id}/members`);
  const bobCard = pageA.getByTestId("member-card").filter({ hasText: "bob" });
  await expect(bobCard.getByTestId("pin-status")).toContainText("Their key changed.");
  await bobCard.getByRole("button", { name: "Accept the new key" }).click();
  await expect(bobCard.getByTestId("pin-status")).toHaveText("Compared");
  const pin = (await readUserDoc(alice))!.doc.pins[bobApi.id] as { ecdsa: string; earlier?: Array<{ ecdsa: string }> };
  expect(pin.ecdsa).toBe(next.pub.ecdsa);
  expect(pin.earlier?.map((k) => k.ecdsa)).toEqual([(await exportPublicKeys(bob.keys)).ecdsa]);
  await openCash(pageA, id);
  await expect(pageA.getByTestId("line-balance")).toHaveText("110.00");
  await expect(pageA.getByTestId("entry-row")).toHaveCount(3);
  await expect(pageA.getByTestId("warn-problems")).toHaveCount(0);
  await expect(pageA.getByTestId("warn-unconfirmed")).toHaveCount(0);
  await ctxA.close();
});

test("PETTY-413: an entry that another member's tool wrote verifies under that member's pinned key", async ({ browser }) => {
  const { connect } = await import("../../../packages/agent/src/index.js");
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  await pageA.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "read");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  // alice makes a token that may write; her tool adds 5.00 with the token's own key
  await pageA.goto("/");
  await openSettings(pageA);
  await pageA.getByTestId("token-new").click();
  await pageA.getByTestId("token-name").fill("Writer");
  await pageA.getByTestId("token-write").check();
  await pageA.getByTestId("token-passphrase").fill(alice.passphrase);
  await pageA.getByTestId("token-create").click();
  const token = (await pageA.getByTestId("token-value").innerText()).trim();
  await pageA.getByTestId("token-done").click();
  const agent = await connect({ token, apiUrl: `http://127.0.0.1:${process.env["API_PORT"] ?? "3000"}` });
  const [drawer] = (await agent.drawers()).filter((x) => x.id === id);
  await agent.add(id, drawer!.lines[0]!.id, "5", "");
  await openCash(pageB, id);
  await expect(pageB.getByTestId("line-balance")).toHaveText("105.00");
  await expect(pageB.getByTestId("entry-row")).toHaveCount(2);
  await expect(pageB.getByTestId("warn-problems")).toHaveCount(0);
  await expect(pageB.getByTestId("warn-unconfirmed")).toHaveCount(0);
  await ctxA.close(); await ctxB.close();
});
