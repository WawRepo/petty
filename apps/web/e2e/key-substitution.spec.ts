import type { Page } from "@playwright/test";
import { exportPublicKeys, generateUserKeys, safetyNumber } from "@petty/crypto";
import { expect, loginAndUnlock, openSettings, signupWithKeys, test } from "./fixtures.js";

/**
 * The security review of v1.5.26 (PETTY-395): a server or database that hands out keys of its own must not
 * get drawer keys. Here the server is played by routes that rewrite its answers on the way to the page.
 */

/** The server's answers about the signed-in account carry another ECDH key than the vault holds. */
async function swapOwnKey(page: Page): Promise<void> {
  const other = await exportPublicKeys(await generateUserKeys());
  for (const url of ["**/api/me", "**/api/auth/login"]) {
    await page.route(url, async (route) => {
      const response = await route.fetch();
      const body = (await response.json().catch(() => null)) as { pub?: { ecdh: string; ecdsa: string } } | null;
      if (!body?.pub) { await route.fulfill({ response }); return; }
      await route.fulfill({ response, json: { ...body, pub: { ...body.pub, ecdh: other.ecdh } } });
    });
  }
}

test("PETTY-396: the vault does not open when the server names other keys for the account than the vault holds", async ({ page }) => {
  const user = await signupWithKeys("vic");
  await swapOwnKey(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Your vault and the server disagree on your account's keys", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
});

test("PETTY-396: an unlocked vault locks at the next start when the server's keys for the account change; the safety number is the vault's", async ({ page }) => {
  const user = await signupWithKeys("val");
  await loginAndUnlock(page, user);
  await openSettings(page);
  await expect(page.getByTestId("safety-number")).toHaveText(await safetyNumber(await exportPublicKeys(user.keys)));
  await swapOwnKey(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Your vault and the server disagree on your account's keys", { exact: false })).toBeVisible();
});
