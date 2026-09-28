import pg from "pg";
import { expect, loginAndUnlock, signupViaApi, test, openSettings } from "./fixtures.js";

const OWNER_DB = process.env["DATABASE_URL"] ?? "postgres://petty:petty@localhost:5432/petty";

test("back from Admin returns to Settings, and back from Settings returns Home — no loop (PETTY-36)", async ({ page }) => {
  const user = await signupViaApi("looper");
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try { await c.query("update users set is_admin = true where email = $1", [user.email]); } finally { await c.end(); }
  await loginAndUnlock(page, user);
  await openSettings(page);
  await page.getByTestId("admin-link").click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("home-empty")).toBeVisible();
});

test("a deep link's back button goes to the screen's parent instead of leaving the app", async ({ page }) => {
  const user = await signupViaApi("deeplink");
  await loginAndUnlock(page, user);
  await page.goto("/privacy");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
});

test("Settings offers 'Add to home screen' even after the nudge was dismissed", async ({ page }) => {
  const user = await signupViaApi("installer");
  await loginAndUnlock(page, user);
  await page.evaluate(() => localStorage.setItem("petty.installNudge", "no"));
  await page.reload();
  await expect(page.getByTestId("install-nudge")).toHaveCount(0);
  await openSettings(page);
  const section = page.getByTestId("install-section");
  await expect(section.getByRole("heading", { name: "Add to home screen" })).toBeVisible();
  // Headless Chromium fires no beforeinstallprompt, so the manual instructions show.
  await expect(section).toContainText("Add to Home Screen");
});

test("home nudges (PETTY-113): never more than one at a time, and it sits under the total card, not above it", async ({ page }) => {
  const user = await signupViaApi("nudge");
  await loginAndUnlock(page, user);
  await expect(page.locator('[data-testid$="-nudge"]')).toHaveCount(1);
  await expect(page.getByTestId("passkey-nudge")).toBeVisible();
  // The total card (when there are drawers) renders before the nudge in the DOM.
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Tin");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Tin" })).toBeVisible(); // Home is drawn again (Back plays a morph, PETTY-269)
  const order = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[data-testid="home-empty"], [data-testid="home-totals"], [data-testid="passkey-nudge"], [data-testid="drawer-row"]')).map((e) => e.getAttribute("data-testid"));
    return all;
  });
  expect(order.indexOf("passkey-nudge")).toBeGreaterThan(-1);
  expect(order.indexOf("passkey-nudge")).toBeLessThan(order.indexOf("drawer-row"));
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click();
  await expect(page.locator('[data-testid$="-nudge"]')).toHaveCount(0);
});
