import { unlockVault, type VaultBlobV1 } from "@petty/crypto";
import { expect, loginAndUnlock, openSettings, signupViaApi, test } from "./fixtures.js";

/**
 * PETTY-200: Settings makes a new recovery code. Nothing is stored until the code is typed back;
 * after that only the new code opens the recovery copy of the keys.
 */
/** Through the app's own origin, so the session cookie goes along. */
const recoveryCopy = async (page: import("@playwright/test").Page) => {
  const res = await page.request.get("/api/me/recovery-vault");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { recovery_vault: VaultBlobV1 }).recovery_vault;
};

test("a new recovery code is shown, must be typed back, and then replaces the old one", async ({ page }) => {
  const user = await signupViaApi("recode");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const before = (await recoveryCopy(page));

  await openSettings(page);
  await page.getByTestId("new-recovery-code").click();
  await page.getByTestId("recovery-open-form").getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Make the code" }).click();
  const code = (await page.getByTestId("new-recovery-code-value").innerText()).trim();
  expect(code.length).toBeGreaterThan(20);

  // made, not stored: the server still has the old copy until the code is typed back
  expect((await recoveryCopy(page))).toEqual(before);
  const form = page.getByTestId("recovery-confirm-form");
  await form.getByLabel("Type the code to confirm you saved it").fill("WRONG-CODE");
  await form.getByLabel("Login password").fill(user.password);
  await form.getByRole("button", { name: "I saved it" }).click();
  await expect(form.getByText("does not match", { exact: false })).toBeVisible();
  await form.getByLabel("Type the code to confirm you saved it").fill(code);
  await form.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByText("New recovery code saved.")).toBeVisible();

  const after = (await recoveryCopy(page));
  expect(after).not.toEqual(before);
  await expect(unlockVault(after, code)).resolves.toBeTruthy();
});
