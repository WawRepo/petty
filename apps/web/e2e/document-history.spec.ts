import { expect, loginAndUnlock, signupViaApi, test } from "./fixtures.js";

/** PETTY-194: the owner sees earlier versions of a drawer and puts one back. */
test("a renamed drawer can be put back from Earlier versions", async ({ page }) => {
  const user = await signupViaApi("history");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();

  // a change to undo
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Oops");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Oops" })).toBeVisible();

  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-history").click();
  const row = page.getByTestId("history-row").filter({ hasText: "Kitchen" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("0 items");
  await row.getByRole("button", { name: /^Restore the version from/ }).click();
  await expect(page.getByText("Earlier version restored.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();

  // the replaced version ("Oops") is now itself in the list
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-history").click();
  await expect(page.getByTestId("history-row").filter({ hasText: "Oops" })).toBeVisible();
});
