import type { Page } from "@playwright/test";
import { unwrapDrawerKey, openEntryUnverified, fromB64, AuthTagMismatch } from "@petty/crypto";
import { apiClient, dbQuery, expect, loginAndUnlock, signupWithKeys, test, type TestUserWithKeys } from "./fixtures.js";

async function makeDrawer(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const id = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Cash");
  await page.getByLabel("Currency", { exact: true }).fill("EUR");
  await page.getByLabel("Starting balance").fill("100");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR"); // the starting entry is committed
  return id;
}
async function inviteViaUi(page: Page, drawerId: string, who: TestUserWithKeys, role: "write" | "read") {
  await page.goto(`/drawers/${drawerId}/members`);
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.getByLabel("Their email").fill(who.email);
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("invite-found")).toContainText(who.name);
  await expect(page.getByTestId("invite-safety")).toHaveText(/^(\d{5} ){5}\d{5}$/);
  if (role === "read") await page.getByLabel(/Reader/).check();
  await page.getByLabel(/I compared this safety number/).check();
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.locator(".toast")).toHaveText("Invitation sent");
}
async function acceptViaUi(page: Page) {
  await page.goto("/");
  const card = page.getByTestId("pending-invitation").first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("inviter-safety")).toHaveText(/^(\d{5} ){5}\d{5}$/);
  await card.getByLabel(/I compared this number/).check();
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("pending-invitation")).toHaveCount(0);
}

test("invite by email with safety number; no access before accept; reader sees everything but cannot export; emails go out", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const carol = await signupWithKeys("carol");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  const ctxC = await browser.newContext(); const pageC = await ctxC.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Kitchen");
  await inviteViaUi(pageA, id, bob, "write");
  const bobApi = await apiClient(bob);
  expect((await bobApi.call("GET", `/drawers/${id}`)).status).toBe(404);
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await pageB.getByRole("button", { name: "Open Kitchen" }).click();
  await expect(pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect(pageB.getByRole("button", { name: "Add line" })).toBeVisible();
  // bob's Members screen: alice is confirmed (he compared at accept)
  await pageB.getByRole("button", { name: "Drawer options" }).click();
  await pageB.getByRole("button", { name: "Members" }).click();
  await expect(pageB.getByTestId("member-card").filter({ hasText: "alice" }).getByTestId("pin-status")).toHaveText("Confirmed");
  // carol as reader
  await inviteViaUi(pageA, id, carol, "read");
  await loginAndUnlock(pageC, carol);
  await acceptViaUi(pageC);
  await pageC.getByRole("button", { name: "Open Kitchen" }).click();
  await expect(pageC.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect(pageC.getByRole("button", { name: "Add line" })).toHaveCount(0);
  await expect(pageC.getByRole("button", { name: "Confirm state" })).toHaveCount(0);
  await pageC.getByRole("button", { name: "Open Cash" }).click();
  await expect(pageC.getByTestId("entry-row")).toHaveCount(1);
  await expect(pageC.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  const carolApi = await apiClient(carol);
  expect((await carolApi.call("GET", `/drawers/${id}/export`)).status).toBe(403);
  expect((await bobApi.call("GET", `/drawers/${id}/export`)).status).toBe(200);
  // emails
  const mail = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${bob.email}`)}`);
  const j = (await mail.json()) as { messages: Array<{ Subject: string }> };
  expect(j.messages.some((m) => m.Subject === "A drawer was shared with you")).toBe(true);
  await ctxA.close(); await ctxB.close(); await ctxC.close();
});

test("revoke rotates the key: the removed member's old key cannot open anything written afterwards; rotation resumes after an interruption", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  // bob keeps his key (as a departing member could)
  const bobApi = await apiClient(bob);
  const bobWrap = ((await bobApi.call("GET", "/bootstrap")).json as { wraps: Array<{ drawer_id: string; key_version: number; sender_ecdh_pub: string }> }).wraps.find((w) => w.drawer_id === id)!;
  const bobOldKey = await unwrapDrawerKey(bobWrap as never, bob.keys.ecdh.privateKey, { drawer_id: id, key_version: 1, senderEcdhPublicB64: alice.ecdhPub });
  // alice removes bob → her client rotates
  await pageA.goto(`/drawers/${id}/members`);
  await pageA.getByTestId("member-card").filter({ hasText: "bob" }).getByRole("button", { name: "Remove" }).click();
  await pageA.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(pageA.getByTestId("member-card")).toHaveCount(1);
  const aliceApi = await apiClient(alice);
  await expect.poll(async () => ((await aliceApi.call("GET", `/drawers/${id}/rotation`)).json as { completed: boolean; key_version: number }), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 2 });
  expect((await bobApi.call("GET", `/drawers/${id}`)).status).toBe(404);
  expect((await dbQuery("select count(*)::int as n from entries where drawer_id = $1 and key_version = 1", [id]) as { n: number }[])[0]!.n).toBe(0);
  // alice writes a new entry under key 2; bob's old key cannot open it (nor the re-sealed old one)
  await pageA.goto(`/drawers/${id}`);
  await pageA.getByRole("button", { name: "Open Cash" }).click();
  await pageA.getByRole("button", { name: "Add", exact: true }).click();
  await pageA.getByRole("group").getByRole("button", { name: "7", exact: true }).click();
  await pageA.getByRole("button", { name: "Review" }).click();
  await pageA.getByRole("button", { name: "Confirm" }).click();
  await expect(pageA.getByTestId("line-balance")).toHaveText("107.00");
  const exp = (await aliceApi.call("GET", `/drawers/${id}/export`)).json as { entries: Array<{ id: string; line_id: string; author_id: string; key_version: number; nonce: string; ciphertext: string }> };
  expect(exp.entries.every((e) => e.key_version === 2)).toBe(true);
  for (const e of exp.entries) {
    await expect(openEntryUnverified(bobOldKey, { record_type: "entry", record_id: e.id, drawer_id: id, line_id: e.line_id, author_id: e.author_id, key_version: e.key_version, schema_version: 1 }, { nonce: fromB64(e.nonce), ciphertext: fromB64(e.ciphertext) })).rejects.toBeInstanceOf(AuthTagMismatch);
  }
  // interruption: publish key 3 from Node (as a client would in step 1), then let alice's page resume the batches
  const { createDrawerKey, unwrapDrawerKey: unwrap2, wrapDrawerKey } = await import("@petty/crypto");
  const sender = { ecdhPrivate: alice.keys.ecdh.privateKey, ecdhPublicB64: alice.ecdhPub };
  const { selfWrap } = await createDrawerKey(sender, id, 3);
  const k3 = await unwrap2(selfWrap, alice.keys.ecdh.privateKey, { drawer_id: id, key_version: 3, senderEcdhPublicB64: alice.ecdhPub }, { extractable: true });
  const w3 = await wrapDrawerKey(k3, sender, alice.ecdhPub, id, 3);
  expect((await aliceApi.call("POST", `/drawers/${id}/rotation`, { to_version: 3, wraps: [{ user_id: aliceApi.id, wrap: w3 }] })).status).toBe(201);
  expect(((await aliceApi.call("GET", `/drawers/${id}/rotation`)).json as { completed: boolean }).completed).toBe(false);
  await pageA.goto("/");
  await expect.poll(async () => ((await aliceApi.call("GET", `/drawers/${id}/rotation`)).json as { completed: boolean; key_version: number }), { timeout: 20_000 }).toMatchObject({ completed: true, key_version: 3 });
  expect((await dbQuery("select count(*)::int as n from entries where drawer_id = $1 and key_version < 3", [id]) as { n: number }[])[0]!.n).toBe(0);
  await pageA.getByRole("button", { name: "Open Shared" }).click();
  await expect(pageA.getByTestId("line-row").first()).toContainText("107.00 EUR");
  await ctxA.close(); await ctxB.close();
});

test("a replaced public key is detected against the pin: loud warning, inviting blocked until the new key is accepted", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Kitchen");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await pageA.goto(`/drawers/${id}/members`);
  await expect(pageA.getByTestId("member-card").filter({ hasText: "bob" }).getByTestId("pin-status")).toHaveText("Confirmed");
  // the server (or an attacker with DB access) swaps bob's published keys for its own
  const evil = await signupWithKeys("evil");
  const bobId = (await apiClient(bob)).id;
  const evilKeys = (await dbQuery("select ecdh_pub, ecdsa_pub from user_keys where user_id = (select id from users where email = $1)", [evil.email]) as { ecdh_pub: string; ecdsa_pub: string }[])[0]!;
  await dbQuery("update user_keys set retired_at = now() where user_id = $1", [bobId]);
  await dbQuery("insert into user_keys (user_id, ecdh_pub, ecdsa_pub, sig_key_id) values ($1, $2, $3, $4)", [bobId, evilKeys.ecdh_pub, evilKeys.ecdsa_pub, Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")]);
  await pageA.goto(`/drawers/${id}`);
  await expect(pageA.getByTestId("key-changed")).toContainText("The key of bob has changed");
  await pageA.goto(`/drawers/${id}/members`);
  const bobCard = pageA.getByTestId("member-card").filter({ hasText: "bob" });
  await expect(bobCard.getByTestId("pin-status")).toContainText("KEY CHANGED");
  // inviting bob to another drawer is blocked
  await pageA.goto("/");
  const other = await makeDrawer(pageA, "Attic");
  await pageA.goto(`/drawers/${other}/members`);
  await pageA.getByRole("button", { name: "Invite someone" }).click();
  await pageA.getByLabel("Their email").fill(bob.email);
  await pageA.getByRole("button", { name: "Find" }).click();
  await expect(pageA.getByTestId("invite-blocked")).toBeVisible();
  await pageA.getByLabel(/I compared this safety number/).check();
  await expect(pageA.getByRole("button", { name: "Invite", exact: true })).toBeDisabled();
  await pageA.keyboard.press("Escape");
  // accept the new key (after comparing out of band) → allowed again
  await pageA.goto(`/drawers/${id}/members`);
  await bobCard.getByRole("button", { name: "Accept the new key" }).click();
  await expect(bobCard.getByTestId("pin-status")).toHaveText("Confirmed");
  await pageA.goto(`/drawers/${other}/members`);
  await pageA.getByRole("button", { name: "Invite someone" }).click();
  await pageA.getByLabel("Their email").fill(bob.email);
  await pageA.getByRole("button", { name: "Find" }).click();
  await expect(pageA.getByTestId("invite-blocked")).toHaveCount(0);
  await ctxA.close(); await ctxB.close();
});

test("ownership transfer: nothing changes until the target accepts; then roles swap", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Kitchen");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await pageA.goto(`/drawers/${id}/members`);
  await pageA.getByTestId("member-card").filter({ hasText: "bob" }).getByRole("button", { name: "Make owner" }).click();
  await expect(pageA.getByTestId("transfer-pending")).toContainText("Ownership offered to bob");
  await expect(pageA.getByTestId("member-card").filter({ hasText: "alice" })).toContainText("Owner");
  await pageB.goto("/");
  await expect(pageB.getByTestId("pending-transfer")).toContainText("alice wants to hand a drawer over to you");
  await pageB.getByRole("button", { name: "Take ownership" }).click();
  await expect(pageB.getByTestId("pending-transfer")).toHaveCount(0);
  await pageB.goto(`/drawers/${id}/members`);
  await expect(pageB.getByTestId("member-card").filter({ hasText: "bob" })).toContainText("Owner");
  await expect(pageB.getByTestId("member-card").filter({ hasText: "alice" })).toContainText("Writer");
  await expect(pageB.getByRole("button", { name: "Invite someone" })).toBeVisible();
  await pageA.goto(`/drawers/${id}/members`);
  await expect(pageA.getByRole("button", { name: "Leave drawer" })).toBeVisible();
  await ctxA.close(); await ctxB.close();
});

test("a lost or rolled-back trusted-keys document is loud, suspends first-sight trust and blocks sharing until acknowledged (SR-3)", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Kitchen");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await pageA.goto(`/drawers/${id}/members`);
  await expect(pageA.getByTestId("member-card").filter({ hasText: "bob" }).getByTestId("pin-status")).toHaveText("Confirmed");
  // the server "loses" alice's document (a rolled-back backup, or a malicious operator)
  const aliceId = (await apiClient(alice)).id;
  await dbQuery("delete from user_docs where user_id = $1", [aliceId]);
  await pageA.goto("/");
  await expect(pageA.getByTestId("pins-rolled-back")).toBeVisible();
  // bob is NOT silently re-pinned as confirmed
  await pageA.goto(`/drawers/${id}/members`);
  await expect(pageA.getByTestId("member-card").filter({ hasText: "bob" }).getByTestId("pin-status")).not.toHaveText("Confirmed");
  // sharing is refused while the warning stands
  await pageA.goto("/");
  const other = await makeDrawer(pageA, "Attic");
  await pageA.goto(`/drawers/${other}/members`);
  await pageA.getByRole("button", { name: "Invite someone" }).click();
  await pageA.getByLabel("Their email").fill(bob.email);
  await pageA.getByRole("button", { name: "Find" }).click();
  await pageA.getByLabel(/I compared this safety number/).check();
  await pageA.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(pageA.getByRole("alert")).toBeVisible();
  await pageA.keyboard.press("Escape");
  // acknowledge → back to normal
  await pageA.goto("/");
  await pageA.getByRole("button", { name: "I understand, start over" }).click();
  await expect(pageA.getByTestId("pins-rolled-back")).toHaveCount(0);
  await ctxA.close(); await ctxB.close();
});
