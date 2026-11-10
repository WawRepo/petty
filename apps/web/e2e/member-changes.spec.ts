import type { Page } from "@playwright/test";
import { exportPublicKeys, generateDrawerKey, generateUserKeys, safetyNumber, signingKeyId, wrapDrawerKey } from "@petty/crypto";
import { acceptViaUi, apiClient, confirmViaApi, expect, inviteViaUi, loginAndUnlock, makeDrawer, readUserDoc, rowNamed, shareViaApi, signupWithKeys, test, type TestUserWithKeys } from "./fixtures.js";

/**
 * What the app does by itself when the people around a drawer change: an inviter whose keys are not the pinned ones
 * (PETTY-447), and a member who is removed or leaves (PETTY-449). The server is played by routes that rewrite its
 * answers on the way to the page.
 */

interface Keys { ecdh_pub: string; ecdsa_pub: string; sig_key_id: string; created_at: string; retired_at: null }
interface Boot {
  drawers: Array<{ id: string; key_version: number; rotation_needed: boolean }>;
  members: Record<string, unknown[]>;
  wraps: Array<{ drawer_id: string; key_version: number; sender_id?: string }>;
  invitations: Array<{ inviter: { keys: Keys | null } }>;
}
async function rewriteBootstrap(page: Page, change: (boot: Boot) => void): Promise<void> {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const boot = (await response.json()) as Boot;
    change(boot);
    await route.fulfill({ response, json: boot });
  });
}
/** The server never says that a drawer needs a new key. */
const neverNeeded = (boot: Boot): void => { for (const d of boot.drawers) d.rotation_needed = false; };
/** Every request this page makes to rotate or re-seal the drawer. */
function rotationRequests(page: Page, drawerId: string): string[] {
  const seen: string[] = [];
  page.on("request", (r) => { if (new RegExp(`/drawers/${drawerId}/(rotation|export)`).test(r.url())) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return seen;
}
const idOf = async (u: TestUserWithKeys): Promise<string> => (await apiClient(u)).id;
const rotationOf = async (u: TestUserWithKeys, drawerId: string) => (await (await apiClient(u)).call("GET", `/drawers/${drawerId}/rotation`)).json as { completed: boolean; key_version: number };
/** What a person's sealed user document remembers about who left which drawer. */
const leftIn = async (u: TestUserWithKeys) => (await readUserDoc(u))?.doc["drawer_left"] as Record<string, Record<string, number>> | undefined;
/** The invitee accepts with a plain request, as shareViaApi does, when the test needs no page of theirs. */
async function acceptViaApi(u: TestUserWithKeys): Promise<void> {
  const api = await apiClient(u);
  const inv = ((await api.call("GET", "/invitations")).json as { invitations: Array<{ id: string }> }).invitations[0]!;
  expect((await api.call("POST", `/invitations/${inv.id}/accept`)).status).toBe(204);
}
/** `open: false` when the Members screen is already on view and must not load again first. */
async function removeInUi(page: Page, drawerId: string, name: string, open = true): Promise<void> {
  if (open) await page.goto(`/drawers/${drawerId}/members`);
  await page.getByTestId("member-card").filter({ hasText: name }).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(page.getByTestId("member-card").filter({ hasText: name })).toHaveCount(0);
}
/** A write member publishes the next drawer key from outside the browser, wrapped for these people; no row is re-sealed yet. */
async function publishKey(by: TestUserWithKeys, drawerId: string, version: number, forUsers: TestUserWithKeys[]): Promise<void> {
  const api = await apiClient(by);
  const key = await generateDrawerKey({ extractable: true });
  const wraps = [];
  for (const u of forUsers) wraps.push({ user_id: await idOf(u), wrap: await wrapDrawerKey(key, { ecdhPrivate: by.keys.ecdh.privateKey, ecdhPublicB64: by.ecdhPub }, u.ecdhPub, drawerId, version) });
  // the proof is what a server that asks for a custody proof here takes; one that does not ignores it
  expect((await api.call("POST", `/drawers/${drawerId}/rotation`, { to_version: version, wraps, proof: await api.proof(by.keys) })).status).toBe(201);
}

test("PETTY-447: an invitation from someone whose keys are not the ones already pinned shows the key change, and can be accepted only after the new key was accepted as one", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const first = await makeDrawer(pageA, "First");
  await inviteViaUi(pageA, first, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB); // bob compared alice's safety number: her keys are pinned and confirmed
  await pageA.goto("/");
  const second = await makeDrawer(pageA, "Second");
  await inviteViaUi(pageA, second, bob, "write");
  await ctxA.close();
  const aliceId = await idOf(alice);
  const real = await exportPublicKeys(alice.keys);
  // the server hands out the second invitation with other keys for alice
  const other = await exportPublicKeys(await generateUserKeys());
  const otherKeys: Keys = { ecdh_pub: other.ecdh, ecdsa_pub: other.ecdsa, sig_key_id: await signingKeyId(other.ecdsa), created_at: new Date().toISOString(), retired_at: null };
  await rewriteBootstrap(pageB, (boot) => { for (const inv of boot.invitations) inv.inviter.keys = otherKeys; });
  await pageB.goto("/");
  const card = pageB.getByTestId("pending-invitation");
  const accept = card.getByRole("button", { name: "Accept", exact: true });
  await expect(card.getByTestId("inviter-safety")).toHaveText(await safetyNumber(other));
  await expect(card.getByTestId("inviter-key-changed")).toContainText("Their key changed.");
  await expect(card.getByLabel(/I compared this number/)).toBeDisabled();
  await expect(accept).toBeDisabled();
  expect((await readUserDoc(bob))!.doc.pins[aliceId]!.ecdsa).toBe(real.ecdsa);
  // bob compares the new number with alice and accepts the key as a changed key; after that the card works as usual
  await card.getByRole("button", { name: "Accept the new key" }).click();
  await expect(card.getByTestId("inviter-key-changed")).toHaveCount(0);
  await expect(accept).toBeDisabled();
  await card.getByLabel(/I compared this number/).check();
  await expect(accept).toBeEnabled();
  const pin = (await readUserDoc(bob))!.doc.pins[aliceId] as { ecdsa: string; earlier?: Array<{ ecdsa: string }> };
  expect(pin.ecdsa).toBe(other.ecdsa);
  expect(pin.earlier?.map((k) => k.ecdsa)).toEqual([real.ecdsa]);
  await ctxB.close();
});

test("PETTY-449: after Remove the owner's app replaces the drawer key at once, also when the server never says that a new key is needed", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await acceptViaApi(bob);
  await rewriteBootstrap(pageA, neverNeeded);
  await removeInUi(pageA, id, "bob");
  await expect.poll(() => rotationOf(alice, id), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  expect(await leftIn(alice)).toEqual({ [id]: { [await idOf(bob)]: 1 } });
  await ctxA.close();
});

test("PETTY-449: a removal is remembered in the owner's sealed user document: when the device that removed could not replace the key, another one does, without the server's word", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await acceptViaApi(bob);
  await rewriteBootstrap(pageA, neverNeeded);
  // this device cannot publish a new key
  await pageA.route(`**/api/drawers/${id}/rotation`, (route) => (route.request().method() === "POST" ? route.fulfill({ status: 503, json: { code: "Unavailable" } }) : route.fallback()));
  await removeInUi(pageA, id, "bob");
  await expect.poll(async () => (await leftIn(alice))?.[id]).toEqual({ [await idOf(bob)]: 1 });
  // the drawer says that its key is still due, though the server does not
  await pageA.goto(`/drawers/${id}`);
  await expect(pageA.getByTestId("rotation-needed")).toBeVisible();
  expect(await rotationOf(alice, id)).toMatchObject({ key_version: 1 });
  await ctxA.close();
  const ctxN = await browser.newContext(); const pageN = await ctxN.newPage();
  await rewriteBootstrap(pageN, neverNeeded);
  await loginAndUnlock(pageN, alice);
  await expect.poll(() => rotationOf(alice, id), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  await ctxN.close();
});

test("PETTY-449: the person removed held the key the drawer has at that moment, also when another member replaced it since this device last looked", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await shareViaApi(alice, id, bob, "write");
  await shareViaApi(alice, id, carol, "write");
  await confirmViaApi(alice, bob);
  await confirmViaApi(alice, carol);
  await rewriteBootstrap(pageA, neverNeeded);
  await pageA.goto(`/drawers/${id}/members`); // alice's device accepted key version 1
  await expect(pageA.getByTestId("member-card")).toHaveCount(3);
  await expect.poll(async () => (await readUserDoc(alice))?.doc.drawer_keys?.[id]).toBe(1);
  // carol publishes key version 2 for all three; alice's device has not looked since, and removes bob
  await publishKey(carol, id, 2, [alice, bob, carol]);
  await removeInUi(pageA, id, "bob", false);
  await expect.poll(() => rotationOf(alice, id), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 3 });
  expect(await leftIn(alice)).toEqual({ [id]: { [await idOf(bob)]: 2 } });
  await ctxA.close();
});

test("PETTY-449: a member's own app notices that someone left: it says whom to confirm while it must wait, then replaces the key, all without the server's word", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const dave = await signupWithKeys("dave");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await shareViaApi(alice, id, carol, "write");
  await shareViaApi(alice, id, dave, "read");
  await ctxA.close();
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await expect(rowNamed(pageB, "Shared")).toBeVisible(); // bob's user document now knows alice, carol and dave as members
  await rewriteBootstrap(pageB, neverNeeded);
  expect((await (await apiClient(dave)).call("POST", `/drawers/${id}/leave`)).status).toBe(204);
  // bob never compared carol's safety number. His device gives a new key only to confirmed members, so it waits and says so.
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByTestId("rotation-needed")).toBeVisible();
  await expect(pageB.getByTestId("rotation-confirm")).toContainText("Confirm carol in Members");
  expect(await leftIn(bob)).toEqual({ [id]: { [await idOf(dave)]: 1 } });
  expect(await rotationOf(bob, id)).toMatchObject({ key_version: 1 });
  await pageB.getByTestId("rotation-confirm").getByRole("button", { name: "Members" }).click();
  await expect(pageB.getByTestId("rotation-confirm")).toContainText("Confirm carol in Members");
  const carolCard = pageB.getByTestId("member-card").filter({ hasText: "carol" });
  await carolCard.getByRole("button", { name: "Numbers match" }).click();
  await expect(carolCard).toHaveAttribute("data-status", "confirmed");
  await expect.poll(() => rotationOf(bob, id), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  await expect(pageB.getByTestId("rotation-confirm")).toHaveCount(0);
  await ctxB.close();
});

test("PETTY-449: a new key wrapped by someone who was removed from the drawer stays closed, also when the server lists them as a member again; a key they wrapped while a member still opens", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxC = await browser.newContext(); const pageC = await ctxC.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, carol, "write");
  await shareViaApi(alice, id, bob, "write");
  await ctxA.close();
  await loginAndUnlock(pageC, carol);
  await acceptViaUi(pageC);
  // carol compares bob's safety number
  await pageC.goto(`/drawers/${id}/members`);
  const bobCard = pageC.getByTestId("member-card").filter({ hasText: "bob" });
  await bobCard.getByRole("button", { name: "Numbers match" }).click();
  await expect(bobCard).toHaveAttribute("data-status", "confirmed");
  // bob, a writer, publishes key version 2 for all three; carol's page takes it and re-seals the rows under it
  await publishKey(bob, id, 2, [alice, bob, carol]);
  await pageC.goto(`/drawers/${id}`);
  await expect(pageC.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect.poll(() => rotationOf(carol, id), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  await expect.poll(async () => (await readUserDoc(carol))?.doc.drawer_keys?.[id]).toBe(2);
  // alice removes bob and publishes key version 3 for herself and carol; the rows are still under bob's key version 2
  const bobId = await idOf(bob);
  expect((await (await apiClient(alice)).call("DELETE", `/drawers/${id}/members/${bobId}`)).status).toBe(204);
  await publishKey(alice, id, 3, [alice, carol]);
  // carol's page sees that bob is gone. The key he wrapped as a member opens the rows, and her page re-seals them under alice's key.
  await pageC.goto(`/drawers/${id}`);
  await expect(pageC.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect.poll(() => rotationOf(carol, id), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 3 });
  await expect.poll(async () => (await readUserDoc(carol))?.doc.drawer_keys?.[id]).toBe(3);
  // the server hands carol a key version 4 that bob wrapped, lists bob as a member again, and says the rows wait to be re-sealed
  const pub = await exportPublicKeys(bob.keys);
  const bobAgain = { user_id: bobId, display_name: "bob", role: "write", keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id: await signingKeyId(pub.ecdsa), created_at: new Date().toISOString(), retired_at: null } };
  const forged = await wrapDrawerKey(await generateDrawerKey({ extractable: true }), { ecdhPrivate: bob.keys.ecdh.privateKey, ecdhPublicB64: bob.ecdhPub }, carol.ecdhPub, id, 4);
  await rewriteBootstrap(pageC, (boot) => {
    boot.drawers = boot.drawers.map((d) => (d.id === id ? { ...d, key_version: 4 } : d));
    boot.members[id] = [...(boot.members[id] ?? []), bobAgain];
    boot.wraps.push({ ...forged, sender_id: bobId });
  });
  const batches: unknown[] = [];
  await pageC.route(`**/api/drawers/${id}/rotation`, (route) => (route.request().method() === "GET"
    ? route.fulfill({ json: { drawer_id: id, key_version: 4, pending_entries: 1, document_pending: true, photo_pending: false, completed: false } })
    : route.fallback()));
  await pageC.route(`**/api/drawers/${id}/rotation/batch`, async (route) => {
    batches.push(route.request().postDataJSON());
    await route.fulfill({ json: { drawer_id: id, key_version: 4, pending_entries: 0, document_pending: false, photo_pending: false, completed: true } });
  });
  const requests = rotationRequests(pageC, id);
  await pageC.goto(`/drawers/${id}`);
  await expect(pageC.getByRole("alert")).toContainText("someone who left this drawer or was removed from it");
  await pageC.waitForTimeout(2500); // a re-seal would start right after the drawers load
  expect(batches).toEqual([]);
  expect(requests).toEqual([]);
  expect(await leftIn(carol), "carol's user document remembers that bob left while the drawer had key version 2").toEqual({ [id]: { [bobId]: 2 } });
  // in Members, bob counts as not compared for this drawer
  await pageC.getByRole("button", { name: "Members" }).click();
  const again = pageC.getByTestId("member-card").filter({ hasText: "bob" });
  await expect(again).toHaveAttribute("data-status", "unconfirmed");
  await expect(again.getByTestId("pin-status")).toContainText("Left this drawer or was removed from it, and is listed again.");
  // the server answers as it should again: the drawer opens as it was
  await pageC.unrouteAll({ behavior: "wait" });
  await pageC.goto(`/drawers/${id}`);
  await expect(pageC.getByTestId("line-row").first()).toContainText("100.00 EUR");
  // bob was listed and is gone again, so he may hold key version 3: carol's page replaces it
  await expect.poll(() => rotationOf(carol, id), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 4 });
  await ctxC.close();
});
