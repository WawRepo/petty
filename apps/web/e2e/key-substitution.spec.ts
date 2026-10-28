import type { Page } from "@playwright/test";
import { exportPublicKeys, generateDrawerKey, generateUserKeys, safetyNumber, signingKeyId, wrapDrawerKey } from "@petty/crypto";
import { acceptViaUi, apiClient, expect, inviteViaUi, loginAndUnlock, makeDrawer, openSettings, rowNamed, shareViaApi, signupWithKeys, test, type TestUserWithKeys } from "./fixtures.js";

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

interface Boot { drawers: Array<{ id: string; key_version: number; rotation_needed: boolean }>; members: Record<string, unknown[]>; wraps: unknown[] }

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
  await expect(pageB.getByRole("alert")).toContainText("a new key from a member whose safety number you have not confirmed");
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
  await expect(pageB.getByRole("alert")).toContainText("a new key from a member whose safety number you have not confirmed");
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
