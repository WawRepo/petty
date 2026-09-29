import type { Page } from "@playwright/test";
import { apiClient, dbQuery, expect, loginAndUnlock, shareViaApi, signupWithKeys, test } from "./fixtures.js";

async function makeDrawer(page: Page, name: string, withLine = true): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const id = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  if (withLine) {
    await page.getByRole("button", { name: "Add item" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Cash");
    await page.getByLabel("Currency", { exact: true }).fill("EUR");
    await page.getByLabel("Starting balance").fill("100");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByTestId("line-row").first()).toContainText("100.00 EUR");
  }
  return id;
}

test("delete account: blocked until each shared drawer is decided; hand-over needs no acceptance; sole drawer deleted; the giver's old entries still verify for the new owner", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const shared = await makeDrawer(pageA, "Shared");
  const sole = await makeDrawer(pageA, "Sole");
  await shareViaApi(alice, shared, bob, "write");
  // API: no decisions → 409
  const a = await apiClient(alice);
  // ...and never without proof of the signing key (SR-2), whatever the decisions say
  expect((await a.call("POST", "/me/delete", { password: alice.password, decisions: [] })).status).toBe(400);
  const r = await a.call("POST", "/me/delete", { password: alice.password, proof: await a.proof(alice.keys), decisions: [] });
  expect(r.status).toBe(409);
  // UI
  await pageA.goto("/settings");
  await pageA.getByRole("button", { name: "Delete account" }).click();
  await expect(pageA.getByRole("heading", { name: "Delete account" })).toBeVisible();
  await expect(pageA.getByTestId("shared-decision")).toHaveCount(1);
  await expect(pageA.getByTestId("shared-decision")).toContainText("Shared");
  await expect(pageA.getByText("1 drawer only you own will be deleted.")).toBeVisible();
  await pageA.getByLabel("Your login password").fill(alice.password);
  await pageA.getByRole("button", { name: "Delete my account" }).click();
  await expect(pageA.getByRole("alert").last()).toContainText("Decide what happens");
  await pageA.getByTestId("shared-decision").getByLabel(/Give to/).first().check();
  await pageA.getByRole("combobox", { name: /Give to Shared/ }).selectOption({ label: "bob" });
  await pageA.getByRole("button", { name: "Delete my account" }).click();
  await expect(pageA.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(pageA.locator(".toast")).toHaveText("Your account was deleted.");
  // alice cannot come back
  await pageA.getByLabel("Email").fill(alice.email);
  await pageA.getByLabel("Login password").fill(alice.password);
  await pageA.getByRole("button", { name: "Sign in" }).click();
  await expect(pageA.getByRole("alert")).toContainText("Wrong email or password");
  // bob owns Shared now, without accepting; Sole is gone
  expect((await dbQuery("select count(*)::int as n from drawers where id = $1", [sole]) as { n: number }[])[0]!.n).toBe(0);
  await loginAndUnlock(pageB, bob);
  await expect(pageB.getByTestId("drawer-row")).toHaveCount(1);
  await expect(pageB.getByTestId("pending-transfer")).toHaveCount(0);
  await pageB.goto(`/drawers/${shared}/members`);
  await expect(pageB.getByTestId("member-card")).toHaveCount(1);
  await expect(pageB.getByTestId("member-card").first()).toContainText("Owner");
  // the key rotates (alice's device could still hold the old one); afterwards alice's entry still reads and verifies
  const b = await apiClient(bob);
  await expect.poll(async () => ((await b.call("GET", `/drawers/${shared}/rotation`)).json as { completed: boolean; key_version: number }), { timeout: 30_000 }).toMatchObject({ completed: true, key_version: 2 });
  await pageB.goto(`/drawers/${shared}`);
  await pageB.getByRole("button", { name: "Open Cash" }).click();
  await expect(pageB.getByTestId("line-balance")).toHaveText("100.00");
  await expect(pageB.getByTestId("entry-row")).toHaveCount(1);
  await expect(pageB.getByTestId("warn-problems")).toHaveCount(0);
  await expect(pageB.getByRole("button", { name: "by Deleted user" })).toBeVisible();
  await ctxA.close(); await ctxB.close();
});
