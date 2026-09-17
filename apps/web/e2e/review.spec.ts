/**
 * Phase 17 review harness — not a regression test. Runs only with REVIEW=1:
 * captures phone-sized screenshots of every screen (light/dark, en/pl) into
 * REVIEW_OUT and runs axe on each. Findings go to the Plane ticket.
 */
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, loginAndUnlock, makeJoinLink, signupViaApi, test, openSettings } from "./fixtures.js";

const OUT = process.env["REVIEW_OUT"] ?? "/tmp/petty-review";
const PL_WITHDRAW = "Wypłata";
test.skip(!process.env["REVIEW"], "review harness; set REVIEW=1");
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const axeResults: Record<string, unknown[]> = {};
async function shot(page: Page, name: string, axe = true) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  if (axe) {
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]).analyze();
    axeResults[name] = r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
    writeFileSync(`${OUT}/axe.json`, JSON.stringify(axeResults, null, 2));
  }
}

test("capture every screen and run axe", async ({ page, context }) => {
  mkdirSync(OUT, { recursive: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible();
  await shot(page, "000-landing");
  await page.goto(`/join#${await makeJoinLink()}`);
  await expect(page.getByTestId("join-explainer")).toBeVisible();
  await shot(page, "00-join");
  const user = await signupViaApi("Ola");
  // 1. login + unlock
  await page.goto("/login");
  await shot(page, "01-login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await shot(page, "02-unlock");
  await page.getByLabel("Vault passphrase", { exact: true }).fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await shot(page, "03-home-empty");
  // 2. drawer with a line and entries
  await page.getByRole("button", { name: "Add drawer" }).click();
  await shot(page, "04-add-drawer-sheet");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await shot(page, "05-drawer-empty");
  await page.getByRole("button", { name: "Add line" }).click();
  await shot(page, "06-add-line-sheet");
  await page.getByLabel("Name", { exact: true }).fill("Złotówki na zakupy");
  await page.getByLabel("Currency", { exact: true }).fill("PLN");
  await page.getByLabel("Starting balance").fill("1250");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByRole("group").getByRole("button", { name: "Countable" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Glass balls");
  await page.getByLabel("Unit").fill("balls");
  await page.getByLabel("Starting count").fill("12");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByRole("group").getByRole("button", { name: "Single item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Passport");
  await page.getByLabel("Text").fill("expires 2031");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row")).toHaveCount(3);
  await shot(page, "07-drawer");
  await page.getByRole("button", { name: "Open Złotówki na zakupy" }).click();
  await expect(page.getByTestId("line-balance")).toBeVisible();
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  for (const d of "40.50") await page.getByRole("group").getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click();
  await page.getByLabel("Comment (optional)").fill("pizza for everyone on Friday night");
  await shot(page, "08-entry-keypad");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await shot(page, "09-entry-confirm");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  for (const d of "2000") await page.getByRole("group").getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await shot(page, "10-entry-negative-warning");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
  await shot(page, "11-line-negative");
  await page.getByTestId("entry-row").first().getByRole("button", { name: "Entry options" }).click();
  await shot(page, "12-entry-options");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Confirm state" }).click();
  await shot(page, "13-confirm-state");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Drawer options" }).click();
  await shot(page, "14-drawer-options");
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await shot(page, "15-members");
  await page.goto("/");
  await expect(page.getByTestId("drawer-row")).toHaveCount(1);
  await shot(page, "16-home");
  await openSettings(page);
  await shot(page, "17-settings");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await shot(page, "18-passkey-sheet", false);
  await page.keyboard.press("Escape");
  // 3. Polish
  await page.getByLabel("Language").selectOption("pl");
  await shot(page, "19-settings-pl", false);
  await page.goto("/");
  await shot(page, "20-home-pl", false);
  await page.getByRole("button", { name: /Otwórz Kitchen/ }).click();
  await shot(page, "21-drawer-pl", false);
  await page.getByRole("button", { name: /Otwórz Złotówki/ }).click();
  await page.getByRole("button", { name: PL_WITHDRAW, exact: true }).click();
  await shot(page, "22-entry-keypad-pl", false);
  await page.keyboard.press("Escape");
  await page.goto("/settings");
  await page.getByLabel(/Język|Language/).selectOption("en");
  // 4. dark mode
  const dark = await context.browser()!.newContext({ colorScheme: "dark", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const dp = await dark.newPage();
  await loginAndUnlock(dp, user);
  await shot(dp, "30-home-dark");
  await dp.getByRole("button", { name: "Open Kitchen" }).click();
  await shot(dp, "31-drawer-dark");
  await dp.getByRole("button", { name: "Open Złotówki na zakupy" }).click();
  await shot(dp, "32-line-dark");
  await dp.getByRole("button", { name: "Add", exact: true }).click();
  await shot(dp, "33-entry-dark");
  await dp.keyboard.press("Escape");
  await dp.goto("/settings");
  await shot(dp, "34-settings-dark");
  await dark.close();
  writeFileSync(`${OUT}/axe.json`, JSON.stringify(axeResults, null, 2));
});
