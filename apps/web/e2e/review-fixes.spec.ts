import type { Page } from "@playwright/test";
import { expect, loginAndUnlock, makeDrawers, openSettings, shareViaApi, signupViaApi, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-279: the bugs the UI review found (PETTY-278), each checked where a browser can see it. The ids
 * are the review's own: M the main app, S Settings and the other signed-in screens, F the public pages.
 * Elsewhere: F1 in prod.spec.ts (it needs the service worker), S12/S13 in ai.spec.ts, the /device
 * Denied screen in cli.spec.ts.
 */
async function addDrawer(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
}
async function addMoneyLine(page: Page, name: string, currency: string, start: string) {
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Currency", { exact: true }).fill(currency);
  await page.getByLabel("Starting balance").fill(start);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-name").filter({ hasText: name })).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
}
async function keypad(page: Page, digits: string) {
  for (const d of digits) await page.getByRole("group").getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click();
}
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);
/** How long each view transition held the old screen on view: until its update is done, it stays frozen. */
async function timeMorphs(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { morphMs: number[]; morphTimed?: boolean };
    w.morphMs = [];
    if (w.morphTimed) return;
    w.morphTimed = true;
    const doc = document as Document & { startViewTransition: (cb: () => unknown) => { updateCallbackDone: Promise<void> } };
    const original = doc.startViewTransition.bind(doc);
    doc.startViewTransition = (cb) => {
      const t0 = performance.now();
      const change = original(cb);
      void change.updateCallbackDone.then(() => w.morphMs.push(performance.now() - t0));
      return change;
    };
  });
}
const morphMs = (page: Page) => page.evaluate(() => (window as unknown as { morphMs: number[] }).morphMs);

test("M1, M21: Back from a drawer folded into its place does not hold the old screen; a pick on its trail lands Home at the top", async ({ page }) => {
  const user = await signupWithKeys("mia");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  // at All, a drawer in Flat › Kitchen has no bubble of its own: it is folded into Flat's
  await makeDrawers(page, [["Cash tin", ["Flat", "Kitchen"]], ...Array.from({ length: 9 }, (_, i): [string, string[]] => [`Box ${i + 1}`, ["Flat"]])]);
  await page.getByTestId("drawer-row").filter({ hasText: "Cash tin" }).click();
  await expect(page.getByRole("heading", { name: "Cash tin" })).toBeVisible();
  await timeMorphs(page);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  // with places, Home has no "Drawers" header — a wait for one froze Back the same way
  await expect(page.getByTestId("tag-groups")).toBeVisible();
  await expect.poll(() => morphMs(page)).toHaveLength(1);
  // waiting for a bubble that never came held the old screen for 50 × 16 ms and more
  expect((await morphMs(page))[0]).toBeLessThan(600);

  // M21: from far down Home, a drawer; its trail's place goes back to Home at its top, where the total is
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => scrollY(page)).toBeGreaterThan(100);
  await page.getByTestId("drawer-row").filter({ hasText: "Box 9" }).click();
  await expect(page.getByRole("heading", { name: "Box 9" })).toBeVisible();
  await page.getByTestId("place-trail").getByRole("button", { name: "Flat" }).click();
  await expect(page.getByTestId("tag-bar").getByRole("button", { name: /^Flat/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => scrollY(page)).toBe(0);
});

test("F2, F6, S31: a new page opens at its top; the screenshot viewer keeps Tab and holds the page; no Clerk line without Clerk", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); return window.scrollY; })).toBeGreaterThan(500);
  await page.locator(".landing-footer").getByRole("button", { name: "Privacy and security" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect.poll(() => scrollY(page)).toBe(0);
  // S31: this Petty signs in without Clerk, so its privacy page does not speak of Clerk
  await expect(page.locator("main")).not.toContainText("Clerk");

  // F6: Tab stays in the viewer, and the page behind it does not scroll
  await page.goto("/");
  await page.getByRole("button", { name: /^Enlarge: Home screen/ }).click();
  const viewer = page.getByTestId("shot-overlay");
  await expect(viewer.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.locator("html")).toHaveClass(/no-scroll/);
  for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await viewer.evaluate((v) => v.contains(document.activeElement)), `after ${key}`).toBe(true);
  }
  // a step leaves focus where it was (it jumped back to Close, so the next Enter closed the viewer)
  const next = viewer.getByRole("button", { name: "Next screenshot" });
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(viewer.getByText("2/5")).toBeVisible();
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(viewer.getByText("3/5")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveClass(/no-scroll/);
});

test("F3: /reset with no token, or one cut short, says the link is not valid instead of offering a form", async ({ page }) => {
  for (const path of ["/reset", "/reset#abc123"]) {
    await page.goto(path);
    await expect(page.getByTestId("reset-invalid")).toHaveText("This link is invalid, used or older than one hour. Ask for a new one.");
    await expect(page.getByLabel("New password")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("S8: Move starts from the place's own parent; Move up and Move down stop at the ends", async ({ page }) => {
  const user = await signupWithKeys("pat");
  await loginAndUnlock(page, user);
  await makeDrawers(page, [["Cash tin", ["Flat", "Kitchen"]], ["Shoe box", ["Flat", "Bedroom"]]]);
  await page.goto("/places");
  await expect(page.getByTestId("place-name")).toHaveText(["Flat", "Kitchen", "Bedroom"]);
  await page.getByRole("button", { name: "Options for Kitchen" }).click();
  await page.getByTestId("place-move").click();
  const picker = page.getByTestId("move-picker");
  await expect(picker.getByTestId("place-option").filter({ hasText: /^Flat$/ })).toHaveAttribute("aria-pressed", "true");
  await expect(picker.getByTestId("place-option").filter({ hasText: /^Top level$/ })).toHaveAttribute("aria-pressed", "false");
  // Save with no pick keeps it where it is, with no error
  await page.getByTestId("place-move-confirm").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.getByTestId("place-row").nth(1)).toHaveAttribute("data-depth", "1");
  // Kitchen is Flat's first place, Bedroom its last
  await page.getByRole("button", { name: "Options for Kitchen" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move up" })).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move down" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Options for Bedroom" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move up" })).toBeEnabled();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move down" })).toBeDisabled();
});

test("S5, S6, S33: typed keys land in the passphrase fields; a short export password marks its own field; Lock now throws nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const user = await signupViaApi("sal");
  await loginAndUnlock(page, user);
  await openSettings(page);
  // S5: focus used to land on the hidden username field for password managers, and typed keys were lost
  await page.getByRole("button", { name: "Change vault passphrase" }).click();
  const current = page.getByLabel("Current vault passphrase");
  await expect(current).toBeFocused();
  await page.keyboard.type("abc");
  await expect(current).toHaveValue("abc");
  await expect(current).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByTestId("new-recovery-code").click();
  await expect(page.getByLabel("Vault passphrase")).toBeFocused();
  await page.keyboard.type("xyz");
  await expect(page.getByLabel("Vault passphrase")).toHaveValue("xyz");
  await page.keyboard.press("Escape");
  // S6: too short is the password's problem, not the repeat's
  await page.getByRole("button", { name: "Export (encrypted)" }).click();
  await page.getByLabel("Export password", { exact: true }).fill("short");
  await page.getByLabel("Repeat the export password").fill("short");
  await page.getByRole("dialog").getByRole("button", { name: "Download" }).click();
  await expect(page.getByLabel("Export password", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Repeat the export password")).not.toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Escape");
  // S33: the screen still on view as the vault locks does not try to load the drawers
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(page).toHaveURL(/\/unlock$/);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test("S4: Sign out in Settings asks first, as the account menu does", async ({ page }) => {
  const user = await signupViaApi("sid");
  await loginAndUnlock(page, user);
  await openSettings(page);
  await page.getByTestId("settings-sign-out").click();
  const ask = page.getByRole("dialog", { name: "Sign out?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByTestId("settings-sign-out").click();
  await page.getByRole("dialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("S26: the /device form stays while a typed code is checked, and its field carries the error", async ({ page }) => {
  const user = await signupViaApi("dev");
  await loginAndUnlock(page, user);
  await page.goto("/device");
  const field = page.getByTestId("device-code");
  await field.fill("abc");
  await page.getByTestId("device-continue").click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveText("That is not a code. A code has 12 letters, like BCDF-GHJK-LMNP.");
  await field.fill("BCDF-GHJK-LMNP");
  await expect(field).not.toHaveAttribute("aria-invalid", "true"); // typing clears the old error
  await page.getByTestId("device-continue").click();
  await expect(page.getByRole("alert")).toContainText("No request is waiting with this code.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveValue("BCDF-GHJK-LMNP");
});

test("M3, M2, M17: the keypad stops at the currency's decimals; no amount is said under the amount; items say where they cannot move", async ({ page }) => {
  const user = await signupWithKeys("kit");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Tin");
  await addMoneyLine(page, "Euros", "EUR", "10");
  await addMoneyLine(page, "Dollars", "USD", "500");
  await page.getByRole("button", { name: "Open Euros" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // M3: EUR has two decimals, from the keypad and from the keyboard alike
  await keypad(page, "1.2345");
  await expect(page.getByTestId("amount-display")).toHaveText("1.23");
  await page.keyboard.press("9");
  await expect(page.getByTestId("amount-display")).toHaveText("1.23");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("amount-display")).toHaveText("1.2");
  // M2: the missing amount is said under the amount; the optional comment is not marked
  for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
  await expect(page.getByTestId("amount-display")).toHaveText("0");
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("amount-error")).toHaveText("Enter an amount.");
  await expect(page.getByLabel("Comment (optional)")).not.toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Escape");
  // M17: an entry's options have a way out, and Reverse is not a solid red block
  await page.getByTestId("entry-row").first().getByRole("button", { name: "Entry options" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Reverse this entry" })).toHaveClass(/btn-danger-ghost/);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // M17: the first item cannot move up, the last cannot move down
  await page.getByRole("button", { name: "Options for Euros" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move up" })).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move down" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Open Dollars" }).click();
  await page.getByRole("button", { name: "Options for Dollars" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move up" })).toBeEnabled();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move down" })).toBeDisabled();
});

test("M14, M9, M4: a card leads with its largest amount; search finds drawers by name and place, items by currency; a dimmed card hides every amount", async ({ page }) => {
  const user = await signupWithKeys("sam");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Bedroom safe");
  await addMoneyLine(page, "Euros", "EUR", "10");
  await addMoneyLine(page, "Dollars", "USD", "500");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await makeDrawers(page, [["Tool box", ["Garage"]]]);
  // M14: in the order of the totals, largest first — not the order of the items
  const safe = page.getByTestId("drawer-row").filter({ hasText: "Bedroom safe" });
  await expect(safe.getByTestId("row-amount")).toHaveText("500.00 USD");
  await expect(safe.getByTestId("row-amount-more")).toHaveText("10.00 EUR");
  await expect(page.getByTestId("home-totals").getByRole("listitem")).toHaveText(["500.00 USD", "10.00 EUR"]);
  // M9: a currency finds its items; a drawer's name or place finds the drawer with all it holds
  await page.getByTestId("home-search-toggle").click();
  const search = page.getByLabel("Search items and tags in every drawer");
  await search.fill("usd");
  await expect(page.getByTestId("search-count")).toHaveText("1 item in 1 drawer");
  await expect(page.getByTestId("search-hit")).toHaveText(["Dollars500.00 USD"]);
  await search.fill("bedroom");
  await expect(page.getByTestId("search-count")).toHaveText("2 items in 1 drawer");
  await search.fill("garage");
  await expect(page.getByTestId("search-count")).toHaveText("0 items in 1 drawer");
  await expect(page.getByTestId("drawer-group")).toHaveText([/Tool box/]);
  await search.press("Escape");
  // M4: with Garage picked, the safe is one of the other drawers, dimmed: no amount of it shows
  await page.getByTestId("tag-bar").getByRole("button", { name: /^Garage/ }).click();
  await page.getByTestId("other-drawers").getByRole("button", { expanded: false }).click();
  await expect(safe).toHaveClass(/dim/);
  await expect(safe.getByTestId("row-amount")).toBeHidden();
  await expect(safe.getByTestId("row-amount-more")).toBeHidden();
});

test("S1: a member's buttons wrap to a new row instead of squeezing their labels, and Remove comes last", async ({ browser }) => {
  const owner = await signupWithKeys("own");
  const member = await signupWithKeys("mem");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await loginAndUnlock(page, owner);
  const id = await addDrawer(page, "Shared tin");
  await shareViaApi(owner, id, member, "write");
  await page.goto(`/drawers/${id}/members`);
  const buttons = page.getByTestId("member-card").filter({ hasText: "mem" }).locator(".actions .btn");
  await expect(buttons).toHaveText(["I compared this number", "Make owner", "Remove"]);
  // each label on one line: its text makes one line box
  const lines = await buttons.evaluateAll((els) => els.map((b) => {
    const r = document.createRange();
    r.selectNodeContents(b);
    return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
  }));
  expect(lines).toEqual([1, 1, 1]);
  await context.close();
});
