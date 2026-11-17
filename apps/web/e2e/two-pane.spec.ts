import type { Page } from "@playwright/test";
import { expect, loginAndUnlock, makeDrawer, rowNamed, signupWithKeys, test } from "./fixtures.js";

// PETTY-138: from 900 px Home's list stays on the left and the drawer or item opens on the right.
const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** A drawer's row in Home's list. */
const drawerRow = (page: Page, name: string) => page.getByTestId("drawer-row").filter({ has: page.getByTestId("drawer-name").filter({ hasText: new RegExp(`^${name}$`) }) });
const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });

test("two panes at 1280 px: the list stays, the drawer and the item open beside it, focus follows, Escape and Back to the list return to the row", async ({ page }) => {
  await page.setViewportSize(WIDE);
  const user = await signupWithKeys("panes");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("panes")).toBeVisible();
  await expect(page.getByTestId("pane-overview")).toContainText("A drawer you pick in the list opens here.");
  const tin = await makeDrawer(page, "Cash tin");
  const box = await makeDrawer(page, "Shoe box");

  // the new drawer is open on the right, its row is the list's current one; one account button, the list's
  await expect(page.getByTestId("panes")).toBeVisible();
  await expect(drawerRow(page, "Shoe box")).toHaveAttribute("aria-current", "page");
  await expect(drawerRow(page, "Cash tin")).not.toHaveAttribute("aria-current", /.*/);
  await expect(page.getByTestId("account-menu")).toHaveCount(1);
  await expect(page.getByTestId("home-totals")).toHaveCount(0); // the total is Home's right pane, gone while a drawer is open

  // Back to the list: the drawer closes, focus is on its row, the total is back on the right
  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(drawerRow(page, "Shoe box")).toBeFocused();
  await expect(page.locator('[aria-current]')).toHaveCount(0);
  await expect(page.getByTestId("pane-overview").getByTestId("home-totals")).toContainText("200.00");

  // a row opened from the keyboard: focus moves to the right pane's heading
  await drawerRow(page, "Cash tin").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/drawers/${tin}$`));
  await expect(heading(page, "Cash tin")).toBeFocused();
  await expect(drawerRow(page, "Cash tin")).toHaveAttribute("aria-current", "page");
  await expect(drawerRow(page, "Shoe box")).toBeVisible();

  // Escape in the right pane: focus back on the row, the drawer stays open
  await page.keyboard.press("Escape");
  await expect(drawerRow(page, "Cash tin")).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/drawers/${tin}$`));

  // a sheet in the right pane keeps its own Escape: it closes, focus goes back to its button, not to the list
  await page.getByRole("button", { name: "Drawer options" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Drawer options" })).toBeFocused();

  // the item opens in the right pane too; its drawer's row stays marked
  await rowNamed(page, "Cash").click();
  await expect(page).toHaveURL(new RegExp(`/drawers/${tin}/lines/[0-9a-f-]+$`));
  const lineUrl = page.url();
  await expect(heading(page, "Cash")).toBeFocused();
  await expect(drawerRow(page, "Cash tin")).toHaveAttribute("aria-current", "true");

  // the add-entry keypad works there, from the keyboard as well
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.type("25");
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("line-balance")).toHaveText("125.00");
  await expect(drawerRow(page, "Cash tin").getByTestId("row-amount")).toContainText("125.00"); // the list follows
  // the connection's line shows once, in the list, not again in the right pane
  await page.context().setOffline(true);
  await expect(page.getByTestId("offline-banner")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Drawers" }).getByTestId("offline-banner")).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);

  // the item's Back goes to its drawer, focus on the drawer's heading
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/drawers/${tin}$`));
  await expect(heading(page, "Cash tin")).toBeFocused();

  // another row while a drawer is open, then the browser's Back: the first drawer again, focus on its heading
  await drawerRow(page, "Shoe box").click();
  await expect(heading(page, "Shoe box")).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/drawers/${tin}$`));
  await expect(heading(page, "Cash tin")).toBeFocused();
  await expect(drawerRow(page, "Cash tin")).toHaveAttribute("aria-current", "page");

  // deep links: the address alone draws both panes
  await page.goto(lineUrl);
  await expect(heading(page, "Cash")).toBeVisible();
  await expect(drawerRow(page, "Cash tin")).toHaveAttribute("aria-current", "true");
  await expect(drawerRow(page, "Shoe box")).toBeVisible();
  await page.goto(`/drawers/${box}`);
  await expect(heading(page, "Shoe box")).toBeVisible();
  await expect(drawerRow(page, "Shoe box")).toHaveAttribute("aria-current", "page");
  await expect(drawerRow(page, "Cash tin")).not.toHaveAttribute("aria-current", /.*/);
});

test("one column below 900 px: no panes, the drawer replaces Home as before, and the layout follows a resize", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const user = await signupWithKeys("onecol");
  await loginAndUnlock(page, user);
  const tin = await makeDrawer(page, "Cash tin");
  await expect(page.getByTestId("panes")).toHaveCount(0);
  await expect(page.getByTestId("home")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to the list" })).toHaveCount(0);
  await expect(page.getByTestId("account-menu")).toHaveCount(1);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("home").getByTestId("home-totals")).toContainText("100.00");
  await expect(page.locator('[aria-current]')).toHaveCount(0);

  // a deep link on a phone is the drawer alone
  await page.goto(`/drawers/${tin}`);
  await expect(heading(page, "Cash tin")).toBeVisible();
  await expect(page.getByTestId("home")).toHaveCount(0);

  // wider: the list comes in beside the open drawer; narrower again: it goes
  await page.setViewportSize(WIDE);
  await expect(page.getByTestId("panes")).toBeVisible();
  await expect(drawerRow(page, "Cash tin")).toHaveAttribute("aria-current", "page");
  await expect(heading(page, "Cash tin")).toBeVisible();
  await page.setViewportSize(PHONE);
  await expect(page.getByTestId("panes")).toHaveCount(0);
  await expect(page.getByTestId("home")).toHaveCount(0);
  await expect(heading(page, "Cash tin")).toBeVisible();
});
