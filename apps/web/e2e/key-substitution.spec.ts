import type { Browser, Page } from "@playwright/test";
import { exportPublicKeys, generateDrawerKey, generateUserKeys, safetyNumber, signingKeyId, wrapDrawerKey } from "@petty/crypto";
import { acceptViaUi, apiClient, dbQuery, editUserDoc, expect, inviteViaUi, loginAndUnlock, makeDrawer, openSettings, readUserDoc, rowNamed, shareViaApi, signupWithKeys, test, type TestUserWithKeys } from "./fixtures.js";

/**
 * The security review of v1.5.26 (PETTY-395): a server or database that hands out keys of its own must not
 * get drawer keys. Here the server is played by routes that rewrite its answers on the way to the page.
 */

/** The server's answers about the signed-in account carry another ECDH key than the vault holds. */
async function swapOwnKey(page: Page): Promise<void> {
  const other = await exportPublicKeys(await generateUserKeys());
  for (const url of ["**/api/me", "**/api/auth/login"]) {
    await page.route(url, async (route) => {
      const response = await route.fetch();
      const body = (await response.json().catch(() => null)) as { pub?: { ecdh: string; ecdsa: string } } | null;
      if (!body?.pub) { await route.fulfill({ response }); return; }
      await route.fulfill({ response, json: { ...body, pub: { ...body.pub, ecdh: other.ecdh } } });
    });
  }
}

test("PETTY-396: the vault does not open when the server names other keys for the account than the vault holds", async ({ page }) => {
  const user = await signupWithKeys("vic");
  await swapOwnKey(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Your vault and the server disagree on your account's keys", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
});

test("PETTY-396: an unlocked vault locks at the next start when the server's keys for the account change; the safety number is the vault's", async ({ page }) => {
  const user = await signupWithKeys("val");
  await loginAndUnlock(page, user);
  await openSettings(page);
  await expect(page.getByTestId("safety-number")).toHaveText(await safetyNumber(await exportPublicKeys(user.keys)));
  await swapOwnKey(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Your vault and the server disagree on your account's keys", { exact: false })).toBeVisible();
});

interface Boot { drawers: Array<{ id: string; key_version: number; rotation_needed: boolean }>; members: Record<string, unknown[]>; wraps: Array<{ drawer_id: string; key_version: number; sender_id?: string }> }

/** A user as the server lists a drawer member: the server can add anyone to the list it hands out. */
async function asMember(user: TestUserWithKeys) {
  const pub = await exportPublicKeys(user.keys);
  return { user_id: (await apiClient(user)).id, display_name: user.name, role: "write", keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id: await signingKeyId(pub.ecdsa), created_at: new Date().toISOString(), retired_at: null } };
}

/** The server's bootstrap answer, changed on the way to the page. */
async function rewriteBootstrap(page: Page, change: (boot: Boot) => void): Promise<void> {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const boot = (await response.json()) as Boot;
    change(boot);
    await route.fulfill({ response, json: boot });
  });
}

/** Every request this page makes to rotate or re-seal the drawer. */
function rotationRequests(page: Page, drawerId: string): string[] {
  const seen: string[] = [];
  page.on("request", (r) => { if (new RegExp(`/drawers/${drawerId}/(rotation|export)`).test(r.url())) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return seen;
}

test("PETTY-398: a new key wrapped by a member the server added, whom nobody confirmed, is not used: nothing is re-sealed under it", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ghost = await signupWithKeys("ghost");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await expect(rowNamed(pageB, "Shared")).toBeVisible(); // bob opened key version 1
  await ctxA.close();
  // the server adds ghost to the drawer and gives bob a key version 2 that ghost made and wrapped
  const g = await asMember(ghost);
  const forged = await wrapDrawerKey(await generateDrawerKey({ extractable: true }), { ecdhPrivate: ghost.keys.ecdh.privateKey, ecdhPublicB64: ghost.ecdhPub }, bob.ecdhPub, id, 2);
  await rewriteBootstrap(pageB, (boot) => {
    boot.drawers = boot.drawers.map((d) => (d.id === id ? { ...d, key_version: 2 } : d));
    boot.members[id] = [...(boot.members[id] ?? []), g];
    boot.wraps.push({ ...forged, sender_id: g.user_id });
  });
  await pageB.route(`**/api/drawers/${id}/rotation`, (route) => (route.request().method() === "GET"
    ? route.fulfill({ json: { key_version: 2, pending_entries: 1, document_pending: true, photo_pending: false, completed: false } })
    : route.fallback()));
  await pageB.route(`**/api/drawers/${id}/rotation/batch`, (route) => route.abort());
  const requests = rotationRequests(pageB, id);
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByRole("alert")).toContainText("comes from a member whose safety number you have not confirmed");
  await pageB.waitForTimeout(1500); // a re-seal would start right after the drawer opened
  expect(requests).toEqual([]);
  await ctxB.close();
});

test("PETTY-398: a member the server added does not get the new key: the rotation waits until they are confirmed", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const ghost = await signupWithKeys("ghost");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Mine");
  const g = await asMember(ghost);
  await rewriteBootstrap(pageA, (boot) => {
    boot.drawers = boot.drawers.map((d) => (d.id === id ? { ...d, rotation_needed: true } : d));
    boot.members[id] = [...(boot.members[id] ?? []), g];
  });
  const requests = rotationRequests(pageA, id);
  await pageA.goto(`/drawers/${id}`);
  await expect(pageA.getByTestId("rotation-confirm")).toContainText("Confirm ghost in Members");
  await pageA.waitForTimeout(1500); // the rotation starts right after the drawers load
  expect(requests).toEqual([]);
  await ctxA.close();
});

test("PETTY-398: after a member leaves, a confirmed member replaces the key; the others use it once they confirm that member; an older key is refused", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const dave = await signupWithKeys("dave");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  const ctxC = await browser.newContext(); const pageC = await ctxC.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await inviteViaUi(pageA, id, carol, "write");
  await shareViaApi(alice, id, dave, "read");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await expect(rowNamed(pageB, "Shared")).toBeVisible();
  await loginAndUnlock(pageC, carol);
  await acceptViaUi(pageC);
  // carol compares bob's safety number; alice is away
  await pageC.goto(`/drawers/${id}/members`);
  const bobCard = pageC.getByTestId("member-card").filter({ hasText: "bob" });
  await bobCard.getByRole("button", { name: "Numbers match" }).click();
  await expect(bobCard).toHaveAttribute("data-status", "confirmed");
  await ctxA.close();
  // dave leaves; carol's page replaces the key for alice and bob, both confirmed by her
  expect((await (await apiClient(dave)).call("POST", `/drawers/${id}/leave`)).status).toBe(204);
  await pageC.goto(`/drawers/${id}`);
  const carolApi = await apiClient(carol);
  await expect.poll(async () => (await carolApi.call("GET", `/drawers/${id}/rotation`)).json, { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  // bob has not compared carol's number yet: her new key waits for that
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByRole("alert")).toContainText("comes from a member whose safety number you have not confirmed");
  await pageB.getByRole("button", { name: "Members" }).click();
  const carolCard = pageB.getByTestId("member-card").filter({ hasText: "carol" });
  await carolCard.getByRole("button", { name: "Numbers match" }).click();
  await expect(carolCard).toHaveAttribute("data-status", "confirmed");
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  // the server goes back to key version 1, which dave may still hold
  await rewriteBootstrap(pageB, (boot) => { boot.drawers = boot.drawers.map((d) => (d.id === id ? { ...d, key_version: 1 } : d)); });
  await pageB.reload();
  await expect(pageB.getByRole("alert")).toContainText("The server sent an older key for this drawer");
  await ctxB.close(); await ctxC.close();
});

// ---------------------------------------------------------------- PETTY-438: whose drawer keys are taken

interface Shared { alice: TestUserWithKeys; bob: TestUserWithKeys; id: string; ghost: Awaited<ReturnType<typeof asMember>>; forged: Awaited<ReturnType<typeof wrapDrawerKey>>; ctxB: Awaited<ReturnType<Browser["newContext"]>>; pageB: Page }

/** Alice shares a drawer with bob in the app and both confirm each other. `forged` is a key version 2 that "ghost", an account nobody confirmed, wrapped for bob. */
async function sharedDrawer(browser: Browser): Promise<Shared> {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ghost = await signupWithKeys("ghost");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await expect(rowNamed(pageB, "Shared")).toBeVisible(); // bob opened key version 1; his user document remembers it
  await ctxA.close();
  const forged = await wrapDrawerKey(await generateDrawerKey({ extractable: true }), { ecdhPrivate: ghost.keys.ecdh.privateKey, ecdhPublicB64: ghost.ecdhPub }, bob.ecdhPub, id, 2);
  return { alice, bob, id, ghost: await asMember(ghost), forged, ctxB, pageB };
}

/** The server lists ghost as a member, hands out ghost's key as version 2, says the rows wait to be re-sealed, and takes every batch. `batches` holds what the page uploads. */
async function serveGhostKey(page: Page, s: Shared, batches: unknown[]): Promise<void> {
  await rewriteBootstrap(page, (boot) => {
    boot.drawers = boot.drawers.map((d) => (d.id === s.id ? { ...d, key_version: 2 } : d));
    boot.members[s.id] = [...(boot.members[s.id] ?? []), s.ghost];
    boot.wraps.push({ ...s.forged, sender_id: s.ghost.user_id });
  });
  await page.route(`**/api/drawers/${s.id}/rotation`, (route) => (route.request().method() === "GET"
    ? route.fulfill({ json: { drawer_id: s.id, key_version: 2, pending_entries: 1, document_pending: true, photo_pending: false, completed: false } })
    : route.fallback()));
  await page.route(`**/api/drawers/${s.id}/rotation/batch`, async (route) => {
    batches.push(route.request().postDataJSON());
    await route.fulfill({ json: { drawer_id: s.id, key_version: 2, pending_entries: 0, document_pending: false, photo_pending: false, completed: true } });
  });
}

/** The server says it has no user document for the account, and answers every save of one as saved. */
async function serveNoUserDoc(page: Page): Promise<void> {
  await page.route("**/api/me/doc", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 204, body: "" }) : route.fulfill({ json: { version: 1, updated_at: new Date().toISOString() } })));
}

const BLOCKED = "Petty cannot check that person now";
const UNCONFIRMED = "comes from a member whose safety number you have not confirmed";

test("PETTY-438: on a browser new to the account, with no user document on the server, a key someone else wrapped stays closed and nothing is re-sealed", async ({ browser }) => {
  const s = await sharedDrawer(browser);
  await s.ctxB.close();
  const ctxN = await browser.newContext(); const pageN = await ctxN.newPage();
  const batches: unknown[] = [];
  await serveGhostKey(pageN, s, batches);
  await serveNoUserDoc(pageN);
  const requests = rotationRequests(pageN, s.id);
  await loginAndUnlock(pageN, s.bob);
  await expect(pageN.getByTestId("pins-rolled-back")).toContainText("The server has no list of your trusted keys");
  await pageN.goto(`/drawers/${s.id}`);
  await expect(pageN.getByRole("alert")).toContainText(BLOCKED);
  await pageN.waitForTimeout(2500); // a re-seal would start right after the drawers load
  expect(batches).toEqual([]);
  expect(requests).toEqual([]);
  await ctxN.close();
});

test("PETTY-438: on the usual browser, while the user document is gone from the server, a key someone else wrapped stays closed and nothing is re-sealed", async ({ browser }) => {
  const s = await sharedDrawer(browser);
  const batches: unknown[] = [];
  await serveGhostKey(s.pageB, s, batches);
  await serveNoUserDoc(s.pageB);
  const requests = rotationRequests(s.pageB, s.id);
  await s.pageB.reload();
  await expect(s.pageB.getByTestId("pins-rolled-back")).toBeVisible();
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(s.pageB.getByRole("alert")).toContainText(BLOCKED);
  await s.pageB.waitForTimeout(2500);
  expect(batches).toEqual([]);
  expect(requests).toEqual([]);
  await s.ctxB.close();
});

test("PETTY-438: with the user document in place, a key version 2 from a member nobody confirmed stays closed and nothing is re-sealed; the real drawer opens again", async ({ browser }) => {
  const s = await sharedDrawer(browser);
  const batches: unknown[] = [];
  await serveGhostKey(s.pageB, s, batches);
  const requests = rotationRequests(s.pageB, s.id);
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(s.pageB.getByRole("alert")).toContainText(UNCONFIRMED);
  await s.pageB.waitForTimeout(2500);
  expect(batches).toEqual([]);
  expect(requests).toEqual([]);
  // the server answers as it should again: the drawer is as it was
  await s.pageB.unrouteAll({ behavior: "wait" });
  await s.pageB.reload();
  await expect(s.pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect(s.pageB.getByTestId("pins-rolled-back")).toHaveCount(0);
  await s.ctxB.close();
});

test("PETTY-438: the first key of a drawer, from a person not confirmed yet, opens only after their safety number is confirmed", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await expect(pageB.getByTestId("pending-invitation")).toBeVisible();
  // bob accepts without the accept card: nothing confirmed alice's safety number
  const bobApi = await apiClient(bob);
  const inv = ((await bobApi.call("GET", "/bootstrap")).json as { invitations: Array<{ id: string }> }).invitations[0]!;
  expect((await bobApi.call("POST", `/invitations/${inv.id}/accept`)).status).toBe(204);
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByRole("alert")).toContainText(UNCONFIRMED);
  await pageB.getByRole("button", { name: "Members" }).click();
  const aliceCard = pageB.getByTestId("member-card").filter({ hasText: "alice" });
  await aliceCard.getByRole("button", { name: "Numbers match" }).click();
  await expect(aliceCard).toHaveAttribute("data-status", "confirmed");
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await ctxA.close(); await ctxB.close();
});

test("PETTY-438: an account with drawers and no user document: own drawers open at once, a shared one after a new list is started and its sender confirmed; another browser then opens both", async ({ browser }) => {
  const s = await sharedDrawer(browser);
  await s.pageB.goto("/");
  await makeDrawer(s.pageB, "Own");
  await s.ctxB.close();
  // the account as it was before Petty kept this document: drawers, and no user document at all
  await dbQuery("delete from user_docs where user_id = $1", [(await apiClient(s.bob)).id]);
  const ctxN = await browser.newContext(); const pageN = await ctxN.newPage();
  const requests = rotationRequests(pageN, s.id);
  await loginAndUnlock(pageN, s.bob);
  await expect(pageN.getByTestId("pins-rolled-back")).toContainText("The server has no list of your trusted keys");
  await expect(rowNamed(pageN, "Own")).toContainText("100.00 EUR");
  await expect(rowNamed(pageN, "Shared")).toHaveCount(0);
  await pageN.goto(`/drawers/${s.id}`);
  await expect(pageN.getByRole("alert")).toContainText(BLOCKED);
  await pageN.goto("/");
  await pageN.getByRole("button", { name: "Start a new list of trusted keys" }).click();
  await expect(pageN.getByTestId("pins-rolled-back")).toHaveCount(0);
  await expect(rowNamed(pageN, "Own")).toContainText("100.00 EUR");
  await pageN.goto(`/drawers/${s.id}`);
  await expect(pageN.getByRole("alert")).toContainText(UNCONFIRMED);
  await pageN.getByRole("button", { name: "Members" }).click();
  const aliceCard = pageN.getByTestId("member-card").filter({ hasText: "alice" });
  await aliceCard.getByRole("button", { name: "Numbers match" }).click();
  await expect(aliceCard).toHaveAttribute("data-status", "confirmed");
  await pageN.goto(`/drawers/${s.id}`);
  await expect(pageN.getByTestId("line-row").first()).toContainText("100.00 EUR");
  expect(requests).toEqual([]);
  await ctxN.close();
  // one more browser of the same account: the user document is there, nothing to confirm again
  const ctxM = await browser.newContext(); const pageM = await ctxM.newPage();
  await loginAndUnlock(pageM, s.bob);
  await expect(rowNamed(pageM, "Own")).toContainText("100.00 EUR");
  await expect(rowNamed(pageM, "Shared")).toContainText("100.00 EUR");
  await expect(pageM.getByTestId("pins-rolled-back")).toHaveCount(0);
  await ctxM.close();
});

test("PETTY-438: another key at a key version already accepted is refused, also from a confirmed member", async ({ browser }) => {
  const s = await sharedDrawer(browser);
  const aliceId = (await apiClient(s.alice)).id;
  const fp = (await readUserDoc(s.bob))?.doc.drawer_key_fps?.[s.id]?.["1"];
  expect(fp, "the user document keeps a fingerprint of the accepted key").toMatch(/^[0-9a-f]{64}$/);
  const other = await wrapDrawerKey(await generateDrawerKey({ extractable: true }), { ecdhPrivate: s.alice.keys.ecdh.privateKey, ecdhPublicB64: s.alice.ecdhPub }, s.bob.ecdhPub, s.id, 1);
  await rewriteBootstrap(s.pageB, (boot) => {
    boot.wraps = boot.wraps.map((w) => (w.drawer_id === s.id && w.key_version === 1 ? { ...other, sender_id: aliceId } : w));
  });
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(s.pageB.getByRole("alert")).toContainText("The server sent another key for this drawer");
  await s.ctxB.close();
});

test("PETTY-438: a user document from before fingerprints keeps its drawers open and then remembers their keys; no rotation continues under a key from a member not confirmed", async ({ browser }) => {
  const s = await sharedDrawer(browser);
  const aliceId = (await apiClient(s.alice)).id;
  // as an older Petty left it: the accepted key version, no fingerprint, and alice pinned but never confirmed
  await editUserDoc(s.bob, (doc) => { delete doc.drawer_key_fps; doc.pins[aliceId]!.confirmed_at = null; });
  await s.pageB.goto(`/drawers/${s.id}`);
  await expect(s.pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect.poll(async () => (await readUserDoc(s.bob))?.doc.drawer_key_fps?.[s.id]?.["1"] ?? "").toMatch(/^[0-9a-f]{64}$/);
  // the same older document, now listing key version 2: the server's version 2 comes from ghost, and the rows are still at version 1
  await editUserDoc(s.bob, (doc) => { delete doc.drawer_key_fps; doc.drawer_keys = { ...doc.drawer_keys, [s.id]: 2 }; doc.pins[aliceId]!.confirmed_at = new Date().toISOString(); });
  const batches: unknown[] = [];
  await serveGhostKey(s.pageB, s, batches);
  const requests = rotationRequests(s.pageB, s.id);
  await s.pageB.reload();
  await expect(s.pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await s.pageB.waitForTimeout(2500); // a re-seal would start right after the drawers load
  expect(batches).toEqual([]);
  expect(requests).toEqual([]);
  await s.ctxB.close();
});

test("PETTY-438: with no connection after a reload, a drawer someone else shared still opens from what this device kept", async ({ browser }) => {
  const s = await sharedDrawer(browser);
  await s.pageB.goto("/");
  await expect(rowNamed(s.pageB, "Shared")).toContainText("100.00 EUR");
  await s.pageB.route("**/api/**", (r) => void r.abort("internetdisconnected"));
  await openSettings(s.pageB);
  await s.pageB.getByRole("button", { name: "Lock now" }).click();
  await expect(s.pageB.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await s.pageB.reload();
  await s.pageB.getByLabel("Vault passphrase").fill(s.bob.passphrase);
  await s.pageB.getByRole("button", { name: "Unlock" }).click();
  await expect(s.pageB.getByTestId("offline-banner")).toContainText("Showing what was loaded last time");
  await expect(rowNamed(s.pageB, "Shared")).toContainText("100.00 EUR");
  await s.ctxB.close();
});
