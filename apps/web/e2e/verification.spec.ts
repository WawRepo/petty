import type { Page } from "@playwright/test";
import { dbQuery, expect, loginAndUnlock, shareViaApi, signupWithKeys, test, openSettings } from "./fixtures.js";

async function setupDrawer(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const id = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("PLN kitchen");
  await page.getByLabel("Currency", { exact: true }).fill("PLN");
  await page.getByLabel("Starting balance").fill("1234,56");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("button", { name: "Single item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Passport");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row")).toHaveCount(2);
  return id;
}

test("confirm state: every line listed, ticks default present, badge turns green, any change makes it stale, an absent item is flagged in history", async ({ page }) => {
  const user = await signupWithKeys("lou");
  await loginAndUnlock(page, user);
  const id = await setupDrawer(page, "Kitchen");
  await expect(page.getByTestId("verify-bar")).toHaveAttribute("data-status", "never");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("verify-badge")).toHaveAttribute("data-status", "never");
  await expect(page.getByTestId("verify-badge")).toContainText("Not checked yet");
  await page.getByRole("button", { name: "Open Kitchen" }).click();
  // confirm: balances shown, passport ticked by default
  await page.getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.getByTestId("confirm-state-lines")).toContainText("PLN kitchen1,234.56 PLN");
  const tick = page.getByRole("checkbox", { name: "Passport is present" });
  await expect(tick).toBeChecked();
  await page.getByLabel("Comment (optional)").fill("counted with Bob");
  await page.getByRole("dialog").getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.locator(".toast")).toHaveText("Drawer checked");
  await expect(page.getByTestId("verify-bar")).toHaveAttribute("data-status", "verified");
  await expect(page.getByTestId("verify-bar")).toContainText("Checked just now — counted with Bob");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("verify-badge")).toContainText("Checked · just now");
  await expect(page.getByTestId("verify-badge")).toHaveAttribute("data-status", "verified");
  // any change of any kind makes it stale: a rename
  await page.getByRole("button", { name: "Open Kitchen" }).click();
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByRole("button", { name: "Rename drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Kitchen 2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("verify-bar")).toHaveAttribute("data-status", "stale");
  await expect(page.getByTestId("verify-bar")).toContainText("but something changed since");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("verify-badge")).toContainText("Check again");
  // confirm again with the passport absent → flagged row in history
  await page.getByRole("button", { name: "Open Kitchen 2" }).click();
  await page.getByRole("button", { name: "Mark as checked" }).click();
  await page.getByRole("checkbox", { name: "Passport is present" }).uncheck();
  await page.getByRole("dialog").getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.getByTestId("verify-bar")).toHaveAttribute("data-status", "verified");
  await page.getByRole("button", { name: "History (2)" }).click();
  const rows = page.getByTestId("verification-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass(/flagged/);
  await expect(rows.nth(0)).toContainText("Missing: Passport");
  await expect(rows.nth(0)).toContainText("Passport: absent");
  await expect(rows.nth(1)).not.toHaveClass(/flagged/);
  await expect(rows.nth(1)).toContainText("counted with Bob");
  await expect(rows.nth(1)).toContainText("PLN kitchen: 1,234.56 PLN · Passport: present");
  void id;
});

test("another member's photo change or entry makes the verification stale for everyone", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await setupDrawer(pageA, "Shared");
  await pageA.getByRole("button", { name: "Mark as checked" }).click();
  await pageA.getByRole("dialog").getByRole("button", { name: "Mark as checked" }).click();
  await expect(pageA.getByTestId("verify-bar")).toHaveAttribute("data-status", "verified");
  await shareViaApi(alice, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await pageB.goto(`/drawers/${id}`);
  await expect(pageB.getByTestId("verify-bar")).toHaveAttribute("data-status", "verified");
  // bob replaces the photo (a real canvas JPEG)
  const jpeg = Buffer.from(await pageB.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 300; c.height = 200;
    c.getContext("2d")!.fillStyle = "#39c"; c.getContext("2d")!.fillRect(0, 0, 300, 200);
    const b = await new Promise<Blob>((res) => c.toBlob((x) => res(x!), "image/jpeg", 0.8));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await pageB.locator("#photo-input").setInputFiles({ name: "p.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(pageB.getByTestId("drawer-photo")).toBeVisible();
  await pageA.reload();
  await expect(pageA.getByTestId("verify-bar")).toHaveAttribute("data-status", "stale");
  // alice confirms again; bob logs an entry → stale again
  await pageA.getByRole("button", { name: "Mark as checked" }).click();
  await pageA.getByRole("dialog").getByRole("button", { name: "Mark as checked" }).click();
  await expect(pageA.getByTestId("verify-bar")).toHaveAttribute("data-status", "verified");
  await pageB.goto(`/drawers/${id}`);
  await pageB.getByRole("button", { name: "Open PLN kitchen" }).click();
  await pageB.getByRole("button", { name: "Add", exact: true }).click();
  await pageB.getByRole("group").getByRole("button", { name: "5", exact: true }).click();
  await pageB.getByRole("button", { name: "Review" }).click();
  await pageB.getByRole("button", { name: "Save", exact: true }).click();
  await expect(pageB.getByTestId("confirm-summary")).toBeHidden();
  await pageA.reload();
  await expect(pageA.getByTestId("verify-bar")).toHaveAttribute("data-status", "stale");
  await ctxA.close(); await ctxB.close();
});

test("relative time uses real plural forms: '3 days ago' in English, '3 dni temu' in Polish", async ({ page }) => {
  const user = await signupWithKeys("max");
  await loginAndUnlock(page, user);
  const id = await setupDrawer(page, "Attic");
  await page.getByRole("button", { name: "Mark as checked" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.getByTestId("verify-bar")).toHaveAttribute("data-status", "verified");
  // move both server timestamps back three days (a verification with nothing after it)
  await dbQuery("update drawers set last_write_at = now() - interval '3 days', last_verified_at = now() - interval '3 days' where id = $1", [id]);
  await page.goto("/");
  await expect(page.getByTestId("verify-badge")).toHaveText("Checked · 3 days ago");
  await openSettings(page);
  await page.getByLabel("Language").selectOption("pl");
  await page.getByRole("button", { name: "Wstecz" }).click();
  await expect(page.getByTestId("verify-badge")).toHaveText("Sprawdzono · 3 dni temu");
  await dbQuery("update drawers set last_write_at = now() - interval '1 day', last_verified_at = now() - interval '1 day' where id = $1", [id]);
  await page.reload();
  await expect(page.getByTestId("verify-badge")).toHaveText("Sprawdzono · 1 dzień temu");
  await dbQuery("update drawers set last_write_at = now() - interval '5 days', last_verified_at = now() - interval '5 days' where id = $1", [id]);
  await page.reload();
  await expect(page.getByTestId("verify-badge")).toHaveText("Sprawdzono · 5 dni temu");
});
