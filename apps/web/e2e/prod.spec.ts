/**
 * Production shape: the API serves the built app with strict headers. Any CSP
 * violation (inline script/style, third-party request, WASM without the right
 * source, Trusted Types sink) fails the test. The whole crypto path runs under
 * the policy: signup (Argon2id WASM), unlock, drawer, entry.
 */
import { expect, test, type Page } from "@playwright/test";
import { makeJoinLink, choosePassphraseDoor } from "./fixtures.js";

async function armCspTrap(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile ?? ""}:${e.lineNumber ?? 0}`));
  });
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  return async () => [...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)), ...consoleErrors.filter((t) => /Content Security Policy|Trusted Type/i.test(t))];
}

test("strict headers are served; signup, unlock, drawer and entry work under the CSP; SRI is on the assets; the shell loads offline", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const violations = await armCspTrap(page);
  const res = await page.goto("/login");
  const h = res!.headers();
  expect(h["content-security-policy"]).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(h["content-security-policy"]).not.toContain("unsafe-inline");
  expect(h["content-security-policy"]).toContain("require-trusted-types-for 'script'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["x-frame-options"]).toBe("DENY");
  const html = await page.content();
  expect(html).toMatch(/<script[^>]+integrity="sha384-/);
  expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+integrity="sha384-/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // full crypto path under the policy
  const token = await makeJoinLink();
  await page.goto(`/join#${token}`);
  const run = crypto.randomUUID().slice(0, 8);
  await page.getByLabel("Your name").fill("Pat");
  await page.getByLabel("Email").fill(`pat-${run}@e2e.local`);
  await page.getByLabel("Login password").fill(`login-${run}-pw`);
  await choosePassphraseDoor(page);
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`orange kettle drifts ${run}`);
  await page.getByLabel("Repeat the vault passphrase").fill(`orange kettle drifts ${run}`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Your recovery code" })).toBeVisible({ timeout: 30_000 });
  const code = (await page.getByTestId("recovery-code").textContent())!.trim();
  await page.getByLabel("Type the code to confirm you saved it").fill(code);
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Cash");
  await page.getByLabel("Currency", { exact: true }).fill("EUR");
  await page.getByLabel("Starting balance").fill("12");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row").first()).toContainText("12.00 EUR");
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy and security" })).toBeVisible();
  await page.goto("/ai"); // PETTY-173: config blocks and links under the same policy
  await expect(page.getByRole("heading", { name: "Use Petty with AI" })).toBeVisible();
  expect(await violations()).toEqual([]);
  // service worker: shell offline
  await page.goto("/login");
  const swErrors: string[] = [];
  page.on("console", (m) => { if (/service ?worker|workbox|sw\.js/i.test(m.text())) swErrors.push(`${m.type()}: ${m.text()}`); });
  await page.waitForFunction(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; }, undefined, { timeout: 30_000 });
  await page.reload();
  const diag = await page.evaluate(async () => ({ keys: await caches.keys(), hasIndex: !!(await caches.match("/index.html", { ignoreSearch: true })), controller: !!navigator.serviceWorker.controller }));
  expect(diag, JSON.stringify({ diag, swErrors })).toMatchObject({ hasIndex: true, controller: true });
  // PETTY-279: with the worker in charge, a file of its own (the notices, linked from the footer) is that
  // file — the worker used to answer it with the app shell, which then said "This page does not exist"
  await page.goto("/THIRD_PARTY_NOTICES.md");
  await expect(page.locator("body")).toContainText("Third-party notices");
  await expect(page.locator("#root")).toHaveCount(0);
  // PETTY-195: go offline only once this online load has shown (and so cached) the drawers
  await page.goto("/");
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await ctx.setOffline(true);
  await page.reload();
  // signed in and unlocked → the shell boots from cache straight into the home screen, with its drawers
  await expect(page.getByRole("heading", { name: "Petty" })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3000);
  const offlineText = await page.locator("main").innerText();
  expect(offlineText, `offline home text: ${offlineText}`).toContain("Kitchen");
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await ctx.setOffline(false);
  expect(await violations()).toEqual([]);
  await ctx.close();
});

test("the landing page's tour film loads from this server under the CSP, only after the click (PETTY-329)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const violations = await armCspTrap(page);
  const films: number[] = [];
  page.on("response", (r) => { if (r.url().endsWith("/landing/tour/petty-tour.mp4")) films.push(r.status()); });
  await page.goto("/");
  await expect(page.getByTestId("tour-open")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(films).toEqual([]);
  await page.getByTestId("tour-open").click();
  await expect(page.getByRole("dialog", { name: "A tour of Petty" })).toBeVisible();
  await expect.poll(() => films.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(films.every((s) => s === 200 || s === 206), `film responses: ${films.join(",")}`).toBe(true);
  expect(await violations()).toEqual([]);
  await ctx.close();
});
