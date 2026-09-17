import { expect, test } from "@playwright/test";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SW = fileURLToPath(new URL("../dist/sw.js", import.meta.url));
test("a new service worker reloads an open page onto the new shell (PETTY-144)", async ({ page }) => {
  const original = readFileSync(SW, "utf8");
  try {
    await page.goto("/");
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active, undefined, { timeout: 30_000 });
    await page.reload(); // now controlled by the worker
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.evaluate(() => { (window as unknown as { __old: boolean }).__old = true; });
    appendFileSync(SW, `\n// deploy ${Date.now()}\n`); // a byte-different worker = a new deploy
    for (const ext of [".br", ".gz"]) if (existsSync(SW + ext)) renameSync(SW + ext, SW + ext + ".off"); // the server prefers the compressed twins
    const reloaded = page.waitForEvent("load", { timeout: 30_000 });
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    await reloaded;
    expect(await page.evaluate(() => (window as unknown as { __old?: boolean }).__old ?? false)).toBe(false);
  } finally {
    writeFileSync(SW, original);
    for (const ext of [".br", ".gz"]) if (existsSync(SW + ext + ".off")) renameSync(SW + ext + ".off", SW + ext);
  }
});
