import type { Page } from "@playwright/test";
import { deleteNewestEntry, expect, loginAndUnlock, shareViaApi, signupWithKeys, swapCiphertexts, test } from "./fixtures.js";

async function makeLine(page: Page, drawer: string, line: string, currency: string, start: string): Promise<{ drawerId: string; lineId: string }> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(drawer);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: drawer })).toBeVisible();
  const drawerId = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Name", { exact: true }).fill(line);
  await page.getByLabel("Currency", { exact: true }).fill(currency);
  await page.getByLabel("Starting balance").fill(start);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: `Open ${line}` }).click();
  await expect(page.getByTestId("line-balance")).toBeVisible();
  const lineId = /\/lines\/([0-9a-f-]+)/.exec(page.url())![1]!;
  return { drawerId, lineId };
}
async function keypad(page: Page, digits: string) {
  for (const d of digits) await page.getByRole("group").getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click();
}
async function entry(page: Page, op: "Add" | "Withdraw" | "Adjust", digits: string, comment = "") {
  await page.getByRole("button", { name: op, exact: true }).click();
  await keypad(page, digits);
  if (comment) await page.getByLabel("Comment (optional)").fill(comment);
  await page.getByRole("button", { name: "Review" }).click();
}
const balance = (page: Page) => page.getByTestId("line-balance").textContent();
/** Click Confirm and wait until the server has answered: the confirm summary is gone (sheet closed, or replaced by the recount prompt). */
async function confirmEntry(page: Page) {
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
}

test("withdraw with confirm step, negative warning and red balance; Adjust with delta hint; Reverse once; refusals", async ({ page }) => {
  const user = await signupWithKeys("jo");
  await loginAndUnlock(page, user);
  await makeLine(page, "Kitchen", "PLN", "PLN", "100");
  await expect(page.getByTestId("line-balance")).toHaveText("100.00");
  // withdraw 40.50 with comment
  await entry(page, "Withdraw", "40.50", "pizza");
  const summary = page.getByTestId("confirm-summary");
  await expect(summary).toContainText("Current balance100.00 PLN");
  await expect(summary).toContainText("Change−40.50 PLN");
  await expect(summary).toContainText("New balance59.50 PLN");
  await confirmEntry(page);
  await expect(page.getByTestId("line-balance")).toHaveText("59.50");
  await expect(page.getByTestId("entry-row").first()).toContainText("Withdraw");
  await expect(page.getByTestId("entry-row").first()).toContainText("pizza");
  await expect(page.getByTestId("entry-row").first()).toContainText("−40.50");
  // withdraw below zero: warned, allowed, flagged
  await entry(page, "Withdraw", "100");
  await expect(page.getByTestId("negative-warning")).toContainText("takes the balance to −40.50 PLN");
  await confirmEntry(page);
  await expect(page.getByTestId("line-balance")).toHaveText("−40.50");
  await expect(page.getByTestId("line-balance")).toHaveClass(/negative/);
  await expect(page.getByTestId("warn-negative")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("line-row").first().locator(".rowbalance")).toHaveClass(/negative/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-attention")).toBeVisible();
  await page.getByRole("button", { name: "Open Kitchen" }).click();
  await page.getByRole("button", { name: "Open PLN" }).click();
  // adjust to 10: checkpoint, delta hint shown, older entries no longer reversible
  await entry(page, "Adjust", "10");
  await expect(page.getByTestId("confirm-summary")).toContainText("Change+50.50 PLN");
  await confirmEntry(page);
  await expect(page.getByTestId("line-balance")).toHaveText("10.00");
  await expect(page.getByTestId("warn-negative")).toBeHidden();
  await expect(page.getByTestId("entry-row")).toHaveCount(1);
  await expect(page.getByTestId("entry-row").first()).toContainText("Adjust");
  await expect(page.getByTestId("entry-row").first()).toContainText("10.00 (+50.50)");
  await page.getByTestId("entry-row").first().getByRole("button", { name: "Entry options" }).click();
  await expect(page.getByTestId("reverse-refused")).toContainText("Adjust cannot be reversed");
  await expect(page.getByRole("button", { name: "Reverse this entry" })).toBeDisabled();
  await page.keyboard.press("Escape");
  // load older: the pre-checkpoint entries are shown, but reversing one is refused
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(page.getByTestId("entry-row")).toHaveCount(4);
  await page.getByTestId("entry-row").nth(1).getByRole("button", { name: "Entry options" }).click();
  await expect(page.getByTestId("reverse-refused")).toContainText("Already reconciled by a later count");
  await page.keyboard.press("Escape");
  // add 5, reverse it, try again
  await entry(page, "Add", "5");
  await confirmEntry(page);
  await expect(page.getByTestId("line-balance")).toHaveText("15.00");
  await page.getByTestId("entry-row").first().getByRole("button", { name: "Entry options" }).click();
  await page.getByRole("button", { name: "Reverse this entry" }).click();
  await page.getByRole("dialog", { name: "Reverse this entry?" }).getByRole("button", { name: "Reverse this entry" }).click();
  await expect(page.getByTestId("line-balance")).toHaveText("10.00");
  await expect(page.getByTestId("entry-row").first()).toContainText("Reverse · cancels an earlier entry");
  await expect(page.getByTestId("entry-row").nth(1)).toHaveClass(/reversed/);
  await expect(page.getByTestId("entry-row").nth(1)).toContainText("Add · reversed");
  await page.getByTestId("entry-row").nth(1).getByRole("button", { name: "Entry options" }).click();
  await expect(page.getByTestId("reverse-refused")).toContainText("already reversed");
  await page.keyboard.press("Escape");
  await page.getByTestId("entry-row").first().getByRole("button", { name: "Entry options" }).click();
  await expect(page.getByTestId("reverse-refused")).toContainText("Reverse cannot be reversed");
  // author name on tap
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "by Jo" }).first().click();
  await expect(page.locator(".toast")).toHaveText("jo");
});

test("two users: concurrent Adds both survive; concurrent Adjusts → one wins, one recounts; Add before an Adjust → recount; Adjust before an Add → counts on top", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const { drawerId, lineId } = await makeLine(pageA, "Shared", "Cash", "EUR", "100");
  await shareViaApi(alice, drawerId, bob, "write");
  await loginAndUnlock(pageB, bob);
  await pageB.goto(`/drawers/${drawerId}/lines/${lineId}`);
  await expect(pageB.getByTestId("line-balance")).toHaveText("100.00");
  // simultaneous adds
  await Promise.all([
    (async () => { await entry(pageA, "Add", "50"); await confirmEntry(pageA); })(),
    (async () => { await entry(pageB, "Add", "30"); await confirmEntry(pageB); })(),
  ]);
  await pageA.reload(); await pageB.reload();
  await expect(pageA.getByTestId("line-balance")).toHaveText("180.00");
  await expect(pageB.getByTestId("line-balance")).toHaveText("180.00");
  await expect(pageA.getByTestId("entry-row")).toHaveCount(3);
  await expect(pageA.getByRole("button", { name: "by Bob" })).toHaveCount(1);
  // simultaneous adjusts: one wins
  await Promise.all([
    (async () => { await entry(pageA, "Adjust", "200"); await confirmEntry(pageA); })(),
    (async () => { await entry(pageB, "Adjust", "150"); await confirmEntry(pageB); })(),
  ]);
  const which = await Promise.race([
    pageA.getByRole("alert").filter({ hasText: "Count again" }).waitFor({ timeout: 15_000 }).then(() => "A" as const),
    pageB.getByRole("alert").filter({ hasText: "Count again" }).waitFor({ timeout: 15_000 }).then(() => "B" as const),
  ]);
  const loser = which === "A" ? pageA : pageB;
  const winner = which === "A" ? pageB : pageA;
  await expect(winner.getByRole("alert").filter({ hasText: "Count again" })).toHaveCount(0);
  await loser.getByRole("button", { name: "OK" }).click();
  await pageA.reload(); await pageB.reload();
  const a = await balance(pageA); const b = await balance(pageB);
  expect(a).toEqual(b);
  expect(["200.00", "150.00"]).toContain(a);
  // Add first, then an Adjust counted before it → recount
  await entry(pageB, "Add", "10"); await confirmEntry(pageB);
  await entry(pageA, "Adjust", "999"); await confirmEntry(pageA);
  await expect(pageA.getByRole("alert").filter({ hasText: "Count again" })).toBeVisible();
  await pageA.getByRole("button", { name: "OK" }).click();
  await expect(pageA.getByTestId("line-balance")).toHaveText(`${Number(a!.replace(".", "")) / 100 + 10}.00`);
  // Adjust first, then an Add on top
  await entry(pageA, "Adjust", "300"); await confirmEntry(pageA);
  await expect(pageA.getByTestId("line-balance")).toHaveText("300.00");
  await pageB.reload();
  await entry(pageB, "Add", "7"); await confirmEntry(pageB);
  await expect(pageB.getByTestId("line-balance")).toHaveText("307.00");
  await ctxA.close(); await ctxB.close();
});

test("tampering: a deleted newest entry is caught by the pinned head; swapped ciphertexts fail to open and are kept out of the balance", async ({ page }) => {
  const user = await signupWithKeys("kim");
  await loginAndUnlock(page, user);
  const { drawerId, lineId } = await makeLine(page, "Safe", "Cash", "EUR", "100");
  await entry(page, "Add", "20"); await confirmEntry(page);
  await entry(page, "Add", "5"); await confirmEntry(page);
  await expect(page.getByTestId("line-balance")).toHaveText("125.00");
  // attacker deletes the newest row
  await deleteNewestEntry(drawerId, lineId);
  await page.reload();
  await expect(page.getByTestId("warn-chain-truncated")).toContainText("shorter than the last time you saw it");
  await expect(page.getByTestId("line-balance")).toHaveText("120.00");
  await page.getByRole("button", { name: "Accept as is" }).click();
  await expect(page.getByTestId("warn-chain-truncated")).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("warn-chain-truncated")).toBeHidden();
  // attacker swaps two ciphertexts: AAD binds each to its row → both fail to open
  await swapCiphertexts(drawerId, lineId);
  await page.reload();
  await expect(page.getByTestId("warn-problems")).toContainText("2 entries could not be read");
  await expect(page.getByTestId("line-balance")).toHaveText("0.00");
  await page.goto("/");
  await expect(page.getByTestId("drawer-attention")).toBeVisible();
  await expect(page.getByTestId("totals-incomplete")).toBeVisible();
});

test("after saving an entry the page jumps to the top and the new entry is highlighted (PETTY-65)", async ({ page }) => {
  const user = await signupWithKeys("mo");
  await loginAndUnlock(page, user);
  await page.setViewportSize({ width: 390, height: 500 }); // a short phone viewport so the history overflows
  await makeLine(page, "Kitchen", "PLN", "PLN", "100");
  for (let i = 0; i < 6; i++) { await entry(page, "Add", "1"); await confirmEntry(page); }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await entry(page, "Withdraw", "2", "bread");
  await confirmEntry(page);
  await expect(page.getByTestId("entry-row").first()).toContainText("bread");
  await expect(page.getByTestId("entry-row").first()).toHaveClass(/fresh/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("the computer keyboard drives the amount keypad: digits, decimal, Backspace, Enter reviews, Escape cancels", async ({ page }) => {
  const user = await signupWithKeys("kb");
  await loginAndUnlock(page, user);
  await makeLine(page, "Kitchen", "PLN", "PLN", "100");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const display = page.getByTestId("amount-display");
  await page.keyboard.type("123.45");
  await expect(display).toHaveText("123.45");
  await page.keyboard.press("Backspace");
  await expect(display).toHaveText("123.4");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("confirm-summary")).toContainText("+123.40 PLN");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("confirm-summary")).toBeHidden();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.type("7");
  await expect(display).toHaveText("7");
  await page.keyboard.press("Escape");
  await expect(display).toBeHidden();
  await expect(page.getByTestId("line-balance")).toHaveText("100.00");
});
