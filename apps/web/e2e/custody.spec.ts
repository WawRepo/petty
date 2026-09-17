import { expect, signupWithKeys, test, openSettings } from "./fixtures.js";

test("recovery code sets a new passphrase; passphrase change from settings; old passphrases stop working", async ({ page }) => {
  const user = await signupWithKeys("quinn");
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  // forgot it: recovery code → new passphrase
  await page.getByRole("button", { name: /Use your recovery code/ }).click();
  await page.getByLabel("Recovery code").fill("AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA");
  await page.getByLabel("New vault passphrase", { exact: true }).fill(`recovered kettle ${user.name} 1`);
  await page.getByLabel("Repeat the new passphrase").fill(`recovered kettle ${user.name} 1`);
  await page.getByLabel("Your login password").fill(user.password);
  await page.getByRole("button", { name: "Set new passphrase" }).click();
  await expect(page.getByRole("alert")).toContainText("did not open the vault");
  await page.getByLabel("Recovery code").fill(user.recoveryCode);
  await page.getByRole("button", { name: "Set new passphrase" }).click();
  await expect(page.locator(".toast")).toHaveText("Vault passphrase changed. Unlock with the new one.");
  await page.getByLabel("Vault passphrase", { exact: true }).fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toContainText("did not open the vault");   // the old one is gone
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`recovered kettle ${user.name} 1`);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  // change it again from settings
  await openSettings(page);
  await page.getByRole("button", { name: "Change vault passphrase" }).click();
  await page.getByLabel("Current vault passphrase").fill(`recovered kettle ${user.name} 1`);
  await page.getByLabel("New vault passphrase", { exact: true }).fill(`changed kettle ${user.name} 2`);
  await page.getByLabel("Repeat the new passphrase").fill(`changed kettle ${user.name} 2`);
  await page.getByLabel("Your login password").fill(user.password);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".toast")).toHaveText("Vault passphrase changed.");
  await page.getByRole("button", { name: "Lock now" }).click();
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`changed kettle ${user.name} 2`);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
});
