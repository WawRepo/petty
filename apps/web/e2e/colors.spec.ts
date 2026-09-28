import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, loginAndUnlock, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-252: a drawer takes a colour from the app's palette, picked with its icon. The colour lives in the
 * drawer's encrypted document, like the icon, and shows wherever the drawer is drawn: its tile on Home, its
 * bubble in the Home picture, the middle of its own picture. Green is the default and is stored as none.
 */
async function addDrawer(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
}
async function openIconAndColour(page: Page) {
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-icon").click();
  return page.getByRole("dialog", { name: "Icon and colour" });
}

test("a drawer's colour, picked with its icon, shows on its tile, its Home bubble and its picture; Green goes back to the default", async ({ page }) => {
  const user = await signupWithKeys("col");
  await loginAndUnlock(page, user);
  const shed = await addDrawer(page, "Shed");
  const sheet = await openIconAndColour(page);
  const swatches = sheet.getByTestId("color-picker");
  await expect(swatches.getByRole("button")).toHaveCount(8);
  await expect(swatches.getByRole("button", { name: "Green" })).toHaveAttribute("aria-pressed", "true");
  // a colour saves at once and the sheet stays; the icons below take it
  await swatches.getByRole("button", { name: "Teal" }).click();
  await expect(swatches.getByRole("button", { name: "Teal" })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.locator(".c-teal").getByTestId("icon-picker")).toBeVisible();
  const axe = (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(axe.map((v) => v.id)).toEqual([]);
  // an icon saves and closes, as before
  await sheet.getByTestId("icon-picker").getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("drawer-head").locator(".tile")).toHaveAttribute("data-icon", "wrench");
  await expect(page.getByTestId("drawer-art")).toHaveClass(/c-teal/);

  // it is part of the drawer: after a reload, Home draws the tile and the bubble in it
  await page.goto("/");
  await addDrawer(page, "Kitchen");
  await page.getByRole("button", { name: "Back" }).click();
  const tile = page.getByTestId("drawer-row").filter({ hasText: "Shed" }).locator(".tile");
  await expect(tile).toHaveClass(/c-teal/);
  expect(await tile.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(27, 113, 116)"); // --dc-teal, light theme
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).locator(".tile")).not.toHaveClass(/c-/);
  await expect(page.getByTestId("home-art").locator(".uc-bub.sat.c-teal")).toHaveCount(1);

  // Green is the default again
  await page.goto(`/drawers/${shed}`);
  const again = await openIconAndColour(page);
  await again.getByTestId("color-picker").getByRole("button", { name: "Green" }).click();
  await expect(again.getByTestId("color-picker").getByRole("button", { name: "Green" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drawer-art")).not.toHaveClass(/c-teal/);
});
