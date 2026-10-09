import { choosePassphraseDoor, expect, makeJoinLink, test } from "./fixtures.js";

/**
 * PETTY-350: the three places a new visitor gave up (go-to-market review, PETTY-145): the vault step read
 * like homework, the recovery code had to be copied by hand, and the first screen was blank.
 */
test("a new account: one line says what the vault step does, the code copies in one tap, an empty home offers three starts", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/join#${await makeJoinLink()}`);
  const run = crypto.randomUUID().slice(0, 8);
  await page.getByLabel("Your name").fill("Onno");
  await page.getByLabel("Email").fill(`onno-${run}@e2e.local`);
  await page.getByLabel("Login password").fill(`login-${run}-pw`);
  await choosePassphraseDoor(page);
  // the step in one line; the why is there, folded
  await expect(page.getByTestId("vault-lead")).toHaveText("One more step: choose a vault passphrase that only you know. It opens your drawers, and Petty never sees it.");
  const why = page.getByTestId("join-explainer").locator("li");
  await expect(why.first()).toBeHidden();
  await page.getByText("Why a second lock?").click();
  await expect(why).toHaveCount(3);
  await expect(why.first()).toBeVisible();
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`orange kettle drifts ${run}`);
  await page.getByLabel("Repeat the vault passphrase").fill(`orange kettle drifts ${run}`);
  await page.getByRole("button", { name: "Create account" }).click();

  // the recovery code: one tap copies it, and the whole code is still typed back
  await expect(page.getByRole("heading", { name: "Your recovery code" })).toBeVisible({ timeout: 30_000 });
  const code = (await page.getByTestId("recovery-code").textContent())!.trim();
  await page.getByTestId("recovery-copy").click();
  await expect(page.locator(".toast")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await page.getByLabel("Type the code to confirm you saved it").fill(code.split("-").pop()!);
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByRole("alert")).toContainText("does not match");
  await page.getByLabel("Type the code to confirm you saved it").fill(code);
  await page.getByRole("button", { name: "I saved it" }).click();

  // an empty home: three ways to start; one opens Add drawer with a name to keep or change
  const empty = page.getByTestId("home-empty");
  await expect(empty).toContainText("No drawers yet.");
  await expect(empty.getByRole("group", { name: "Start with a drawer" }).getByRole("button")).toHaveText(["Things around the home", "Family papers", "Cash at home"]);
  await page.getByTestId("starter-cash").click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Kitchen tin");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: /Add drawer/ }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(""); // the plain button starts empty
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("starter-papers").click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
});
