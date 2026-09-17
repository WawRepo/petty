/**
 * Passkey first (Phase 14 → PETTY-102) with Chromium virtual authenticators (CTAP2, platform,
 * user-verifying, PRF-capable). No real biometrics; the authenticator still computes a real PRF
 * output, so the whole wrap/unwrap path is exercised. One browser context = one device; each
 * has its own authenticator, so a passkey made on the "phone" does not exist on the "laptop".
 * The hybrid (QR) transport itself cannot be driven here; what the browser does after it —
 * an unlock through a passkey this device does not know — is simulated by forgetting the
 * device's memory of its own passkey.
 */
import { expect, makeJoinLink, openSettings, test, type TestUser } from "./fixtures.js";
import type { CDPSession, Page } from "@playwright/test";

async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
  return { cdp, id: authenticatorId };
}

/** Day 1: the invitation, a login password, a passkey — no passphrase typed, ever. Returns the recovery code too. */
async function joinWithPasskey(page: Page, name: string): Promise<TestUser & { recoveryCode: string }> {
  const run = Math.random().toString(36).slice(2, 8);
  const user = { name, email: `${name}-${run}@e2e.local`, password: `password-${name}-${run}`, passphrase: "" };
  await page.goto(`/join#${await makeJoinLink()}`);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await expect(page.getByTestId("door-passkey")).toBeVisible();
  await expect(page.getByLabel("Vault passphrase", { exact: true })).toHaveCount(0);
  await page.getByLabel("Name for this passkey").fill("Phone");
  await page.getByRole("button", { name: "Create vault with passkey" }).click();
  await expect(page.getByRole("heading", { name: "Your recovery code" })).toBeVisible({ timeout: 30_000 });
  const recoveryCode = (await page.getByTestId("recovery-code").textContent()) ?? "";
  await page.getByLabel("Type the code to confirm you saved it").fill(recoveryCode);
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  return { ...user, recoveryCode };
}

async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
}

async function lock(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
}

test("day 1: create the vault with a passkey only; unlock with it; the last passkey cannot go without a passphrase; a backup passphrase confirmed by the passkey", async ({ page }) => {
  await virtualAuthenticator(page);
  const user = await joinWithPasskey(page, "pkone");
  // No passphrase → no passphrase field on the unlock screen; the passkey opens it, and this device knows its own passkey: no offer sheet.
  await lock(page);
  await expect(page.getByLabel("Vault passphrase", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Use your recovery code/ })).toBeVisible();
  await page.getByTestId("unlock-passkey").click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await expect(page.getByTestId("passkey-nudge")).toHaveCount(0);
  // Settings: one passkey listed; removing it is refused (no passphrase); a backup passphrase can be set, confirmed by the passkey.
  await openSettings(page);
  const rows = page.getByTestId("passkey-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Phone");
  await rows.first().getByRole("button", { name: /Remove/ }).click();
  const rm = page.locator("form").filter({ has: page.getByRole("button", { name: "Remove", exact: true }) });
  await rm.getByLabel("Your login password").fill(user.password);
  await rm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(rm.getByRole("alert")).toContainText("last passkey");
  await page.keyboard.press("Escape");
  await page.getByTestId("set-passphrase").click();
  const sp = page.getByTestId("set-passphrase-form");
  await sp.getByLabel("New vault passphrase", { exact: true }).fill(`backup kettle ${user.name} 1`);
  await sp.getByLabel("Repeat the new passphrase").fill(`backup kettle ${user.name} 1`);
  await sp.getByLabel("Your login password").fill(user.password);
  await sp.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".toast")).toHaveText("Backup passphrase set.");
  await expect(page.getByRole("button", { name: "Change vault passphrase" })).toBeVisible();
  // Now the passkey may go; the passphrase opens the vault.
  await page.getByTestId("passkey-row").first().getByRole("button", { name: /Remove/ }).click();
  await rm.getByLabel("Your login password").fill(user.password);
  await rm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".toast")).toHaveText("Passkey removed.");
  await expect(page.getByTestId("passkey-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(page.getByTestId("unlock-passkey")).toHaveCount(0);
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`backup kettle ${user.name} 1`);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
});

test("day 2 on a new laptop without the phone: recovery code → passphrase → add a passkey for the laptop; the phone's passkey is removed and no longer opens the vault", async ({ browser, page }) => {
  await virtualAuthenticator(page); // the phone
  const user = await joinWithPasskey(page, "pktwo");

  const laptop = await browser.newContext();
  const lp = await laptop.newPage();
  await virtualAuthenticator(lp); // a different authenticator: the phone's passkey is not here
  await signIn(lp, user);
  await expect(lp.getByTestId("unlock-passkey")).toBeVisible();
  await expect(lp.getByLabel("Vault passphrase", { exact: true })).toHaveCount(0);
  await lp.getByRole("button", { name: /Use your recovery code/ }).click();
  await lp.getByLabel("Recovery code").fill(user.recoveryCode);
  await lp.getByLabel("New vault passphrase", { exact: true }).fill(`laptop kettle ${user.name} 2`);
  await lp.getByLabel("Repeat the new passphrase").fill(`laptop kettle ${user.name} 2`);
  await lp.getByLabel("Your login password").fill(user.password);
  await lp.getByRole("button", { name: "Set new passphrase" }).click();
  await expect(lp.locator(".toast")).toHaveText("Passphrase set. Unlock with it, or with a passkey.");
  await lp.getByLabel("Vault passphrase", { exact: true }).fill(`laptop kettle ${user.name} 2`);
  await lp.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(lp.getByTestId("home-empty")).toBeVisible();
  // This device has no passkey of its own → the nudge; add one, confirmed by the passphrase.
  await lp.getByTestId("passkey-nudge").getByRole("button", { name: "Add passkey" }).click();
  await expect(lp.getByRole("heading", { name: "Settings" })).toBeVisible();
  await lp.getByTestId("passkey-section").getByRole("button", { name: "Add passkey" }).click();
  const add = lp.locator("form").filter({ has: lp.getByRole("button", { name: "Add passkey" }) });
  await add.getByLabel("Name for this passkey").fill("Laptop");
  await add.getByLabel("Vault passphrase", { exact: true }).fill(`laptop kettle ${user.name} 2`);
  await add.getByLabel("Your login password").fill(user.password);
  await add.getByRole("button", { name: "Add passkey" }).click();
  await expect(lp.locator(".toast")).toHaveText("Passkey set up. You can unlock with it from now on.");
  await expect(lp.getByTestId("passkey-row")).toHaveCount(2);
  // Lost phone: remove its passkey from the laptop.
  await lp.getByTestId("passkey-row").filter({ hasText: "Phone" }).getByRole("button", { name: /Remove/ }).click();
  const rm = lp.locator("form").filter({ has: lp.getByRole("button", { name: "Remove", exact: true }) });
  await rm.getByLabel("Your login password").fill(user.password);
  await rm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(lp.locator(".toast")).toHaveText("Passkey removed.");
  await expect(lp.getByTestId("passkey-row")).toHaveCount(1);
  // The laptop's own passkey opens the vault, without typing.
  await lp.getByRole("button", { name: "Lock now" }).click();
  await lp.getByTestId("unlock-passkey").click();
  await expect(lp.getByTestId("home-empty")).toBeVisible();
  await laptop.close();

  // The phone: its passkey is gone from the account → the button is there (one passkey remains) but the phone's authenticator cannot answer; the passphrase does.
  await page.reload();
  await lock(page);
  await page.getByTestId("unlock-passkey").click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await expect(page.getByTestId("home-empty")).toHaveCount(0);
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`laptop kettle ${user.name} 2`);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
});

test("after an unlock through a passkey this device does not know (the phone via QR), the app offers a passkey for this device; declining is remembered, accepting adds one", async ({ page }) => {
  const phone = await virtualAuthenticator(page);
  const user = await joinWithPasskey(page, "pkqr");
  // Forget that this device made the passkey: from now on the unlock looks like one answered by another device.
  await page.evaluate(() => localStorage.removeItem("petty.passkeys.known"));
  await lock(page);
  await page.getByTestId("unlock-passkey").click();
  const offer = page.getByTestId("add-here-form");
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  // Declined once → not asked again for that passkey.
  await lock(page);
  await page.getByTestId("unlock-passkey").click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await expect(offer).toHaveCount(0);
  // Forget again and accept: a second authenticator (Chromium allows one platform authenticator, so this one is a "security key") plays
  // this device's own; the phone's refuses a duplicate via excludeCredentials.
  await page.evaluate(() => localStorage.removeItem("petty.passkeys.known"));
  await phone.cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
  await lock(page);
  await page.getByTestId("unlock-passkey").click();
  await expect(offer).toBeVisible();
  await offer.getByLabel("Name for this passkey").fill("Laptop");
  await offer.getByLabel("Your login password").fill(user.password);
  await offer.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.locator(".toast")).toHaveText("Passkey set up. You can unlock with it from now on.");
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await openSettings(page);
  await expect(page.getByTestId("passkey-row")).toHaveCount(2);
  await expect(page.getByTestId("passkey-row").nth(1)).toContainText("Laptop");
});
