import { expect, loginAndUnlock, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-259: Settings picks the theme — this device's own, light or dark. A chosen theme overrides the
 * device's and is kept on this device, so it is there again before the app draws anything.
 */
const LIGHT = "rgb(245, 243, 239)"; // --bg of each palette (tokens.css)
const DARK = "rgb(21, 20, 18)";

test("the theme: dark and light override the device's, 'Same as this device' follows it again, and a reload keeps the choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const user = await signupWithKeys("thm");
  await loginAndUnlock(page, user);
  await page.goto("/settings");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme = page.getByTestId("settings-theme");
  await expect(theme).toHaveValue("system");
  expect(await bg()).toBe(LIGHT);

  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(bg).toBe(DARK);
  await expect(page.locator('meta[name="theme-color"][media*="light"]')).toHaveAttribute("content", "#151412");

  // light wins over a dark device, and the device's own comes back with "Same as this device"
  await page.emulateMedia({ colorScheme: "dark" });
  await theme.selectOption("light");
  await expect.poll(bg).toBe(LIGHT);
  await theme.selectOption("system");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  await expect.poll(bg).toBe(DARK);

  // kept on this device: after a reload the choice is on the page at once, whatever screen opens
  await page.emulateMedia({ colorScheme: "light" });
  await theme.selectOption("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(bg).toBe(DARK);
});
