import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SW = fileURLToPath(new URL("../dist/sw.js", import.meta.url));

/** A deploy: a byte-different worker (the server prefers the compressed twins, so they step aside). Returns the undo. */
function deploy(): () => void {
  const original = readFileSync(SW, "utf8");
  appendFileSync(SW, `\n// deploy ${Date.now()}\n`);
  for (const ext of [".br", ".gz"]) if (existsSync(SW + ext)) renameSync(SW + ext, SW + ext + ".off");
  return () => {
    writeFileSync(SW, original);
    for (const ext of [".br", ".gz"]) if (existsSync(SW + ext + ".off")) renameSync(SW + ext + ".off", SW + ext);
  };
}

/** Marks the open page, deploys, and checks the new worker reloads it onto the new shell. */
async function reloadsOnDeploy(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __old: boolean }).__old = true; });
  const undo = deploy();
  try {
    const reloaded = page.waitForEvent("load", { timeout: 30_000 });
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    await reloaded;
    expect(await page.evaluate(() => (window as unknown as { __old?: boolean }).__old ?? false)).toBe(false);
  } finally { undo(); }
}

test("a new service worker reloads an open page onto the new shell (PETTY-144)", async ({ page }) => {
  await page.goto("/");
  // PETTY-503: "ready" can resolve while the first worker is still activating; a reload then loads the page
  // without it (CI flake). Wait until it is activated, so this load is a controlled one.
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === "activated", undefined, { timeout: 30_000 });
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await reloadsOnDeploy(page);
});

test("a page opened before the first worker took it over still reloads on the next deploy (PETTY-503)", async ({ page }) => {
  // a first visit: no worker controls this load; the first one takes the page over later (clientsClaim)
  await page.addInitScript(() => { (window as unknown as { __atLoad: boolean }).__atLoad = !!navigator.serviceWorker.controller; });
  await page.goto("/");
  expect(await page.evaluate(() => (window as unknown as { __atLoad?: boolean }).__atLoad)).toBe(false);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  await reloadsOnDeploy(page);
});
