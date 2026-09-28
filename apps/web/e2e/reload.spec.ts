import type { Page } from "@playwright/test";
import { expect, loginAndUnlock, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-245: a full reload of the drawers must not undo a drawer created or deleted while it ran. The
 * reload's /bootstrap is answered by the server at once but handed to the app only later, so the app
 * gets an answer from before the change — the order of events that made a new drawer vanish ("Something
 * went wrong") in the full suite. Dev build only: the test starts the reload through the app's own module.
 */
async function holdBootstrap(page: Page): Promise<{ asked: Promise<void>; release: () => void }> {
  let release!: () => void;
  let asked!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const askedP = new Promise<void>((r) => { asked = r; });
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch(); // the server answers now, before the change
    asked();
    await held;                           // the app gets that answer only after it
    await route.fulfill({ response });
  });
  return { asked: askedP, release };
}
/** Starts a reload in the app's own drawer store: the module URL the app loaded (the dev server may add ?t=). */
async function startReload(page: Page) {
  const status = await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/src\/lib\/drawers\.ts(\?|$)/.test(n)).at(-1);
    if (!url) return "no module";
    const m = (await import(url)) as { loadAll: () => Promise<void>; getDrawers: () => { status: string } };
    const now = m.getDrawers().status;
    void m.loadAll();
    return now;
  });
  expect(status, "the reload must run in the app's own store").toBe("ready");
}
async function reloadDone(page: Page) {
  await page.waitForResponse("**/api/bootstrap");
  await page.unroute("**/api/bootstrap");
  await page.waitForTimeout(800); // the app opens the drawers and writes the store
}
async function addDrawer(page: Page, name: string) {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test("unlocking loads the drawers once, though several parts of Home ask at the same time", async ({ page }) => {
  let asked = 0;
  await page.route("**/api/bootstrap", async (route) => { asked++; await route.continue(); });
  const user = await signupWithKeys("one");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await page.waitForTimeout(800);
  expect(asked).toBe(1);
});

test("a drawer created while the drawers reload stays, and its screen keeps working", async ({ page }) => {
  const user = await signupWithKeys("ria");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  const hold = await holdBootstrap(page);
  await startReload(page);
  await hold.asked;
  await addDrawer(page, "Shed");
  hold.release();
  await reloadDone(page);
  await expect(page.getByText("Something went wrong.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Shed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add line" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Shed" })).toHaveCount(1);
});

test("a drawer deleted while the drawers reload does not come back", async ({ page }) => {
  const user = await signupWithKeys("rob");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Old box");
  const hold = await holdBootstrap(page);
  await startReload(page);
  await hold.asked;
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByRole("button", { name: "Delete drawer" }).click();
  await page.getByTestId("delete-drawer-name").fill("Old box");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  hold.release();
  await reloadDone(page);
  await expect(page.getByTestId("drawer-row")).toHaveCount(0);
  await expect(page.getByTestId("home-empty")).toBeVisible();
});
