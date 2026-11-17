import type { Page } from "@playwright/test";
import { acceptViaUi, apiClient, expect, inviteViaUi, loginAndUnlock, makeDrawer, readUserDoc, rowNamed, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-506: the server keeps a replaced trusted-keys list and a replaced or removed drawer photo for 30 days.
 * It cannot open them; the person's own app opens one and saves it again as a normal write.
 */

/** A JPEG of one color, made in the page. */
async function jpeg(page: Page, color: string): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (color) => {
    const c = document.createElement("canvas"); c.width = 200; c.height = 100;
    const g = c.getContext("2d")!; g.fillStyle = color; g.fillRect(0, 0, 200, 100);
    const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), "image/jpeg", 0.8));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, color));
}

test("PETTY-506: a trusted-keys list that does not open: after a confirm, the newest kept copy that opens is put back, and the drawer someone else shared opens again", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await makeDrawer(pageA, "Shared");
  await inviteViaUi(pageA, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await acceptViaUi(pageB);
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect.poll(async () => (await readUserDoc(bob))?.doc.drawer_revs?.[id] ?? 0).toBeGreaterThan(0);
  const good = (await readUserDoc(bob))!;
  expect(Object.keys(good.doc.pins).length).toBeGreaterThan(0); // alice, pinned when bob accepted

  // a save that does not open, as a session without the vault key can make one; the server keeps the copy it replaced
  const junk = (n: number) => Buffer.alloc(n, 7).toString("base64");
  const api = await apiClient(bob);
  expect((await api.call("PUT", "/me/doc", { base_version: good.version, schema_version: 1, nonce: junk(12), ciphertext: junk(512) })).status).toBe(200);
  await pageB.goto("/");
  const warning = pageB.getByTestId("pins-unreadable");
  await expect(warning).toContainText("Your list of trusted keys does not open");
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByRole("alert")).toContainText("Petty cannot check that person now");

  await pageB.goto("/");
  await warning.getByTestId("pins-put-back").click();
  const dialog = pageB.getByRole("dialog", { name: "Put back an earlier copy?" });
  await dialog.getByRole("button", { name: "Cancel" }).click(); // nothing happens without the confirm
  await expect(warning).toBeVisible();
  await warning.getByTestId("pins-put-back").click();
  await dialog.getByRole("button", { name: "Put it back" }).click();
  await expect(warning).toHaveCount(0);
  const back = (await readUserDoc(bob))!;
  expect(back.doc.pins).toEqual(good.doc.pins);
  expect(back.doc.rev).toBeGreaterThan(good.doc.rev!);
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByTestId("line-row").first()).toContainText("100.00 EUR");
  await expect(pageB.getByRole("alert")).toHaveCount(0);
  await ctxA.close(); await ctxB.close();
});

test("PETTY-506: the owner sees a replaced photo in Earlier versions and puts it back", async ({ page }) => {
  const alice = await signupWithKeys("alice");
  await loginAndUnlock(page, alice);
  const id = await makeDrawer(page, "Shelf");
  const api = await apiClient(alice);
  await page.locator("#photo-input").setInputFiles({ name: "red.jpg", mimeType: "image/jpeg", buffer: await jpeg(page, "#c33") });
  await expect(page.getByTestId("drawer-photo")).toBeVisible();
  await page.locator("#photo-input").setInputFiles({ name: "blue.jpg", mimeType: "image/jpeg", buffer: await jpeg(page, "#33c") });
  await expect.poll(async () => ((await api.call("GET", `/drawers/${id}/photo/history`)).json as { history: unknown[] }).history.length).toBe(1);

  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-history").click();
  const row = page.getByTestId("photo-history-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Replaced photo");
  await row.getByRole("button", { name: /^Show the photo from/ }).click();
  await expect(row.getByTestId("kept-photo")).toBeVisible();
  await row.getByRole("button", { name: /^Put back the photo from/ }).click();
  await expect(page.getByText("Earlier photo restored.")).toBeVisible();
  await expect(page.getByTestId("drawer-photo")).toBeVisible();
  // the photo it replaced is kept in turn
  expect(((await api.call("GET", `/drawers/${id}/photo/history`)).json as { history: unknown[] }).history).toHaveLength(2);
  await page.reload();
  await expect(rowNamed(page, "Cash")).toBeVisible();
  await expect(page.getByTestId("drawer-photo")).toBeVisible();
});
