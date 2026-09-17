/**
 * Clerk mode end to end (PETTY-88, docs/auth-clerk.md). Runs only with CLERK_E2E=1 and the Clerk keys
 * in the root .env; the Playwright config then starts the API in clerk mode. Needs a Clerk user
 * created through the backend API (a +clerk_test address takes the email code 424242):
 *   clerk api /users -d '{"email_address":["petty-user+clerk_test@example.com"],"password":"…","skip_password_checks":true}' --yes
 * Covers: sign in (device-trust email code), vault setup on the first visit or unlock later, a drawer,
 * sign out through the account menu, sign in again, unlock, the drawer is still there.
 */
import { existsSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { choosePassphraseDoor } from "./fixtures.js";
if (existsSync("../../.env")) process.loadEnvFile("../../.env");
test.skip(!process.env["CLERK_E2E"], "clerk mode; set CLERK_E2E=1 with the Clerk keys in .env");
test.beforeAll(async () => { await clerkSetup(); });
const EMAIL = process.env["CLERK_E2E_EMAIL"] ?? "petty-user+clerk_test@example.com";
const PW = process.env["CLERK_E2E_PASSWORD"] ?? "Tester-Passw0rd-2026!";
const PASS = "correct horse battery staple 2026";
async function clerkSignIn(page: Page) {
  await page.goto("/login"); await page.waitForTimeout(2500);
  await page.getByLabel(/email/i).first().fill(EMAIL);
  const c1 = page.getByRole("button", { name: /^continue/i }).first(); if (await c1.count()) await c1.click();
  await page.waitForTimeout(1500);
  await page.getByLabel(/^password/i).first().fill(PW);
  await page.getByRole("button", { name: /^continue/i }).first().click();
  const codeStep = await page.waitForURL(/factor-two|verify/, { timeout: 15_000 }).then(() => true).catch(() => false);
  if (codeStep) {
    // device trust: an email code on a new device; +clerk_test addresses take 424242
    await page.getByRole("textbox").first().click();
    await page.keyboard.type("424242", { delay: 60 });
    const left = await page.waitForURL((u) => !/factor-two|verify/.test(u.toString()), { timeout: 20_000 }).then(() => true).catch(() => false);
    if (!left) await page.getByRole("button", { name: /^continue/i }).first().click().catch(() => undefined);
  }
}
test("clerk flow", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 420, height: 900 });
  await setupClerkTestingToken({ page });
  // 1. sign in with Clerk (user created through the backend API), no vault yet -> setup
  await clerkSignIn(page);
  await page.waitForURL(/\/(setup|unlock)/, { timeout: 40_000 }).catch(() => undefined);
  if (page.url().includes("/setup")) {
    await choosePassphraseDoor(page);
    await page.getByLabel(/^vault passphrase/i).first().fill(PASS);
    await page.getByLabel(/repeat/i).fill(PASS);
    await page.getByRole("button", { name: "Create vault" }).click();
    const code = await page.getByTestId("recovery-code").textContent({ timeout: 60_000 });
    await page.getByRole("textbox").last().fill(code ?? "");
    await page.getByRole("button", { name: /done|continue|wrote/i }).click();
  } else {
    await page.getByLabel("Vault passphrase").fill(PASS);
    await page.getByRole("button", { name: /unlock|open/i }).first().click();
  }
  await expect(page.getByTestId("account-menu")).toBeVisible({ timeout: 20_000 });
  if (!(await page.getByTestId("drawer-row").filter({ hasText: "Clerk tin" }).count())) {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Clerk tin");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Clerk tin" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  }
  // 2. sign out through the account menu; the landing page shows; sign in again -> unlock -> the drawer is there
  await page.getByTestId("account-menu").click();
  await page.getByTestId("menu-sign-out").click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  await page.waitForTimeout(3000);
  await clerkSignIn(page);
  // PETTY-140: after a sign-out the vault must be locked again — the unlock screen, never the drawers.
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible({ timeout: 40_000 });
  await page.getByLabel("Vault passphrase").fill(PASS);
  await page.getByRole("button", { name: /unlock|open/i }).first().click();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Clerk tin" }).first()).toBeVisible({ timeout: 20_000 });
});
