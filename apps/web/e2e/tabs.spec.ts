/**
 * PETTY-450: "Lock now" and a sign-out in one tab reach the other tabs of the same browser at once, and a
 * sign-out made while offline still ends the server's session, at the next start.
 * The tabs are two pages of ONE browser context: they share the cookie, IndexedDB and the channel.
 */
import type { Browser, Page } from "@playwright/test";
import { API, expect, loginAndUnlock, makeDrawer, openSettings, rowNamed, signupViaApi, test } from "./fixtures.js";

/** What the page holds in memory (dev build, the app's own modules): the session's state and the opened drawers. */
async function inMemory(page: Page): Promise<{ status: string; keys: boolean; drawers: number }> {
  return page.evaluate(async () => {
    const loaded = (name: string) => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => new RegExp(`/src/lib/${name}\\.ts(\\?|$)`).test(n)).at(-1) ?? `/src/lib/${name}.ts`;
    const session = (await import(/* @vite-ignore */ loaded("session"))) as { getAuth: () => { status: string; keys?: unknown } };
    const drawers = (await import(/* @vite-ignore */ loaded("drawers"))) as { getDrawers: () => { drawers: Map<string, unknown> } };
    const auth = session.getAuth();
    return { status: auth.status, keys: auth.keys !== undefined, drawers: drawers.getDrawers().drawers.size };
  });
}

/** One person, unlocked in two tabs of one browser, each showing the drawer "Kitchen". */
async function twoTabs(browser: Browser, name: string) {
  const user = await signupViaApi(name);
  const context = await browser.newContext();
  const one = await context.newPage();
  await loginAndUnlock(one, user);
  await makeDrawer(one, "Kitchen");
  const two = await context.newPage();
  await two.goto("/");
  await expect(rowNamed(two, "Kitchen")).toBeVisible();
  expect(await inMemory(two)).toEqual({ status: "unlocked", keys: true, drawers: 1 });
  return { user, context, one, two };
}

test("Lock now in one tab locks the other tab at once: its keys and drawers leave memory", async ({ browser }) => {
  const { user, context, one, two } = await twoTabs(browser, "lock");
  await openSettings(one);
  await one.getByRole("button", { name: "Lock now" }).click();
  await expect(one).toHaveURL(/\/unlock$/);

  // the other tab, untouched: no reload, no click, no return to the foreground
  await expect(two.getByLabel("Vault passphrase")).toBeVisible();
  await expect(two).toHaveURL(/\/unlock$/);
  expect(await inMemory(two)).toEqual({ status: "locked", keys: false, drawers: 0 });

  // it opens again with the passphrase, as after any lock
  await two.getByLabel("Vault passphrase").fill(user.passphrase);
  await two.getByRole("button", { name: "Unlock" }).click();
  await expect(rowNamed(two, "Kitchen")).toBeVisible();
  await context.close();
});

test("a sign-out in one tab signs the other tab out at once", async ({ browser }) => {
  const { context, one, two } = await twoTabs(browser, "out");
  await one.goto("/");
  await one.getByTestId("account-menu").click();
  await one.getByTestId("menu-sign-out").click();
  await one.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  await expect(one.getByTestId("landing-signin").first()).toBeVisible();

  // the other tab, untouched
  await expect(two.getByTestId("landing-signin").first()).toBeVisible();
  await expect(rowNamed(two, "Kitchen")).toHaveCount(0);
  expect(await inMemory(two)).toEqual({ status: "anonymous", keys: false, drawers: 0 });
  await context.close();
});

/**
 * One person signs in, and signs out again while the browser is offline: the logout does not reach the
 * server. All of it happens in one page load that began on the landing page, so the page needs nothing
 * from the network to show the landing page again (the dev server keeps no offline copy of the app).
 */
async function signedOutOffline(browser: Browser, name: string) {
  const user = await signupViaApi(name);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.getByTestId("landing-signin").first().click();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("home")).toHaveAttribute("data-status", "ready");
  const cookie = (await context.cookies()).find((c) => c.name === "petty_session")!.value;
  /** Asked from Node, which stays online: does the server still know the session of that cookie? */
  const session = async (value = cookie): Promise<number> => (await fetch(`${API}/me`, { headers: { cookie: `petty_session=${value}` } })).status;
  expect(await session()).toBe(200);

  await openSettings(page);
  await expect(page.getByTestId("settings-sign-out")).toBeVisible();
  await context.setOffline(true);
  const unsent = page.waitForEvent("requestfailed", (r) => r.url().endsWith("/api/auth/logout"));
  await page.getByTestId("settings-sign-out").click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  await unsent;
  await expect(page.getByTestId("landing-signin").first()).toBeVisible(); // signed out on this device
  expect(await session(), "the server has not heard of the sign-out").toBe(200);
  return { user, context, page, cookie, session };
}

test("a sign-out while offline ends the server's session at the next start", async ({ browser }) => {
  const { user, context, page, cookie, session } = await signedOutOffline(browser, "owed");
  await page.close(); // the app is closed while still offline
  await context.setOffline(false);

  // the next start: the logout goes out before anything else
  const next = await context.newPage();
  await next.goto("/");
  await expect(next.getByTestId("landing-signin").first()).toBeVisible();
  await expect.poll(() => session(), { timeout: 15_000 }).toBe(401);

  // nothing is owed after that: a new sign-in stays signed in across a reload
  await loginAndUnlock(next, user);
  await next.reload();
  await expect(next.getByTestId("home")).toHaveAttribute("data-status", "ready");
  const fresh = (await context.cookies()).find((c) => c.name === "petty_session")!.value;
  expect(fresh).not.toBe(cookie);
  expect(await session(fresh)).toBe(200);
  await context.close();
});

test("a sign-out while offline ends the server's session as soon as the network is back, when the page stayed open", async ({ browser }) => {
  const { context, page, session } = await signedOutOffline(browser, "back");
  await context.setOffline(false); // the browser tells the page that it is online again
  await expect.poll(() => session(), { timeout: 15_000 }).toBe(401);
  await expect(page.getByTestId("landing-signin").first()).toBeVisible();
  await context.close();
});

test("a browser without BroadcastChannel locks and signs out in its one tab, as before", async ({ browser }) => {
  const user = await signupViaApi("solo");
  const context = await browser.newContext();
  await context.addInitScript(() => { delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel; });
  const page = await context.newPage();
  await loginAndUnlock(page, user);
  expect(await page.evaluate(() => typeof BroadcastChannel)).toBe("undefined");
  const cookie = (await context.cookies()).find((c) => c.name === "petty_session")!.value;

  await openSettings(page);
  await page.getByRole("button", { name: "Lock now" }).click();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("home")).toHaveAttribute("data-status", "ready");

  await page.getByTestId("account-menu").click();
  await page.getByTestId("menu-sign-out").click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("landing-signin").first()).toBeVisible();
  expect((await fetch(`${API}/me`, { headers: { cookie: `petty_session=${cookie}` } })).status).toBe(401);
  await context.close();
});
