/**
 * Clerk mode end to end (PETTY-88, docs/auth-clerk.md). Runs only with CLERK_E2E=1 and the Clerk
 * TEST keys in the root .env; the Playwright config then starts the API in clerk mode.
 * Each run makes its own new Clerk user through the backend API (a +clerk_test address takes the
 * email code 424242) and deletes it afterwards, so the first visit, with vault setup and the
 * recovery code (PETTY-199), is always covered. CLERK_E2E_EMAIL reuses an existing user instead.
 * Covers: sign in (device-trust email code), vault setup and the recovery code, a drawer, sign out
 * through the account menu, sign in again, unlock, the drawer is still there.
 */
import { existsSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { choosePassphraseDoor } from "./fixtures.js";
if (existsSync("../../.env")) process.loadEnvFile("../../.env");
test.skip(!process.env["CLERK_E2E"], "clerk mode; set CLERK_E2E=1 with the Clerk keys in .env");
const clerkApi = (path: string, init: RequestInit = {}) =>
  fetch(`https://api.clerk.com/v1${path}`, { ...init, headers: { authorization: `Bearer ${process.env["CLERK_SECRET_KEY"]}`, "content-type": "application/json" } });
const PW = process.env["CLERK_E2E_PASSWORD"] ?? "Tester-Passw0rd-2026!";
let EMAIL = process.env["CLERK_E2E_EMAIL"] ?? "";
let madeUserId: string | null = null;
test.beforeAll(async () => {
  await clerkSetup();
  if (EMAIL) return;
  // only ever against a development instance
  if (!process.env["CLERK_SECRET_KEY"]?.startsWith("sk_test_")) throw new Error("CLERK_E2E needs Clerk test keys");
  EMAIL = `petty-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 6)}+clerk_test@example.com`;
  const res = await clerkApi("/users", { method: "POST", body: JSON.stringify({ email_address: [EMAIL], password: PW, skip_password_checks: true }) });
  if (!res.ok) throw new Error(`clerk user: ${res.status}`);
  madeUserId = ((await res.json()) as { id: string }).id;
});
test.afterAll(async () => { if (madeUserId) await clerkApi(`/users/${madeUserId}`, { method: "DELETE" }); });
const PASS = "correct horse battery staple 2026";
async function clerkSignIn(page: Page) {
  await page.goto("/login"); await page.waitForTimeout(2500);
  await page.getByLabel(/email/i).first().fill(EMAIL);
  const c1 = page.getByRole("button", { name: "Continue", exact: true }); if (await c1.count()) await c1.click();
  await page.waitForTimeout(1500);
  await page.getByLabel(/^password/i).first().fill(PW);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const codeStep = await page.waitForURL(/factor-two|verify|client-trust/, { timeout: 15_000 }).then(() => true).catch(() => false);
  if (codeStep) {
    // device trust: an email code on a new device (Clerk 6: the client-trust step); +clerk_test addresses take 424242
    await page.getByRole("textbox").first().click();
    await page.keyboard.type("424242", { delay: 60 });
    const left = await page.waitForURL((u) => !/factor-two|verify|client-trust/.test(u.toString()), { timeout: 20_000 }).then(() => true).catch(() => false);
    if (!left) await page.getByRole("button", { name: "Continue", exact: true }).click().catch(() => undefined);
  }
}
test("clerk flow", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 420, height: 900 });
  await setupClerkTestingToken({ page });
  // PETTY-185 (NR-5): under the production CSP, no script may come from anywhere but us and Turnstile.
  const blocked: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) blocked.push(m.text()); });
  const scripts: string[] = [];
  page.on("request", (r) => { if (r.resourceType() === "script") scripts.push(r.url()); });
  // 1. sign in with Clerk (user created through the backend API), no vault yet -> setup
  await clerkSignIn(page);
  await page.waitForURL(/\/(setup|unlock)/, { timeout: 40_000 }).catch(() => undefined);
  if (page.url().includes("/setup")) {
    await choosePassphraseDoor(page);
    await page.getByLabel(/^vault passphrase/i).first().fill(PASS);
    await page.getByLabel(/repeat/i).fill(PASS);
    await page.getByRole("button", { name: "Create vault" }).click();
    // PETTY-199: the recovery code must be shown and typed back, not skipped by a redirect home
    const code = await page.getByTestId("recovery-code").textContent({ timeout: 60_000 });
    await page.getByLabel("Type the code to confirm you saved it").fill(code ?? "");
    await page.getByRole("button", { name: "I saved it" }).click();
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
  const base = new URL(page.url()).origin;
  expect(scripts.filter((u) => !u.startsWith(base) && !u.startsWith("https://challenges.cloudflare.com/")), "scripts from elsewhere").toEqual([]);
  expect(blocked.filter((t) => /script-src/.test(t)), "script-src violations").toEqual([]);
});

test("sign up through Clerk: the email code step stays on screen, with no page load between steps, then vault setup (PETTY-283)", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 420, height: 900 });
  await setupClerkTestingToken({ page });
  // Clerk moves through the app's router: one page load for the whole sign-up (each full load used to
  // boot the app again and leave the page blank; after the code it was left empty)
  let loads = 0;
  page.on("load", () => { loads++; });
  const email = `petty-e2e-signup-${Date.now()}+clerk_test@example.com`;
  try {
    await page.goto("/join");
    await page.getByLabel(/email/i).first().fill(email);
    const pw = page.getByLabel(/^password/i).first();
    if (await pw.count()) await pw.fill(PW);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/join\/verify-email-address$/);
    const code = page.getByRole("textbox", { name: /verification code/i });
    await expect(code).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(code).toBeVisible(); // it stays
    await code.click();
    await page.keyboard.type("424242", { delay: 60 });
    await expect(page).toHaveURL(/\/setup$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Set up your vault" })).toBeVisible();
    expect(loads).toBe(1);
  } finally {
    const found = await clerkApi(`/users?email_address=${encodeURIComponent(email)}`);
    for (const u of found.ok ? ((await found.json()) as { id: string }[]) : []) await clerkApi(`/users/${u.id}`, { method: "DELETE" });
  }
});
