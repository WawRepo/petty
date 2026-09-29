import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { apiClient, corruptDocument, expect, jpegWithGpsExif, loginAndUnlock, pickTags, shareViaApi, signupViaApi, signupWithKeys, test, openSettings } from "./fixtures.js";

async function addDrawer(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
}
/** Open a line from the drawer and pick one of its options (PETTY-71: the options sit on the line's screen). */
async function lineOption(page: Page, name: string, option: string) {
  await page.getByRole("button", { name: `Open ${name}` }).click();
  await page.getByRole("button", { name: `Options for ${name}` }).click();
  await page.getByRole("button", { name: option, exact: true }).click();
}
async function addMoneyLine(page: Page, name: string, currency: string, start: string) {
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Currency", { exact: true }).fill(currency);
  await page.getByLabel("Starting balance").fill(start);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-name").filter({ hasText: name })).toBeVisible();
}
const lineNames = (page: Page) => page.getByTestId("line-name").allTextContents();
/** Manage tags (PETTY-155): open a tag from the list, by its name. */
const openTag = (page: Page, tag: string) => page.getByTestId("tag-manager").getByRole("button", { name: new RegExp(`^${tag},`) }).click();

test("create a drawer with money, countable and single lines; totals across two drawers and two currencies; balance from the starting entry", async ({ page }) => {
  const user = await signupWithKeys("fay");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Kitchen");
  await addMoneyLine(page, "PLN kitchen", "pln", "1 234,56");
  await addMoneyLine(page, "Euros", "EUR", "20");
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("button", { name: "Countable" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Glass balls");
  await page.getByLabel("Unit (optional)").fill("balls");
  await page.getByLabel("Starting count").fill("56");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("button", { name: "Single item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Passport");
  await page.getByLabel("Text (optional)").fill("expires 2031");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-row")).toHaveCount(4);
  await expect(page.getByTestId("line-row").nth(0)).toContainText("1,234.56 PLN");
  await expect(page.getByTestId("line-row").nth(2)).toContainText("56 balls");
  // a countable refuses decimals
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByRole("button", { name: "Countable" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Bad");
  await page.getByLabel("Starting count").fill("1.5");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("whole numbers");
  await page.keyboard.press("Escape");
  // second drawer, same currency → summed on the home screen
  await page.getByRole("button", { name: "Back" }).click();
  await addDrawer(page, "Basement");
  await addMoneyLine(page, "Stash", "PLN", "100");
  await page.getByRole("button", { name: "Back" }).click();
  // one currency per line, biggest first
  await expect(page.getByTestId("home-totals").getByRole("listitem")).toHaveText(["1,334.56 PLN", "20.00 EUR"]);
  // the card: headline amount = the first currency, every other currency under it (PETTY-120), the meta row counts items
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).getByTestId("row-amount")).toHaveText("1,234.56 PLN");
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).getByTestId("row-amount-more")).toHaveText("20.00 EUR");
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" })).toContainText("4 items");
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" })).not.toContainText("2 currencies");
  await expect(page.getByTestId("totals-across")).toHaveText("Across 2 drawers");
  // "Part of my total" off for Basement: it leaves the total and says so on its row (PETTY-38)
  await page.getByRole("button", { name: "Open Basement" }).click();
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("counted-switch").uncheck();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home-totals").getByRole("listitem")).toHaveText(["1,234.56 PLN", "20.00 EUR"]);
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Basement" }).getByTestId("not-in-total")).toHaveText("Not in your total");
  // the choice is stored in the encrypted user document: it survives a reload
  await page.reload();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Basement" }).getByTestId("not-in-total")).toBeVisible();
  // nothing counted → no TOTAL block at all
  await page.getByRole("button", { name: "Open Kitchen" }).click();
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("counted-switch").uncheck();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home-totals")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Kitchen" }).click();
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("counted-switch").check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home-totals").getByRole("listitem")).toHaveText(["1,234.56 PLN", "20.00 EUR"]);
  // line screen shows the folded balance
  await page.getByRole("button", { name: "Open Kitchen" }).click();
  await page.getByRole("button", { name: "Open PLN kitchen" }).click();
  await expect(page.getByTestId("line-balance")).toHaveText("1,234.56");
});

test("keyboard-only reorder with Move down / Move up; rename; currency relabel keeps the amount; delete line with history count; delete drawer", async ({ page }) => {
  const user = await signupWithKeys("gus");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Desk");
  await addMoneyLine(page, "A", "USD", "10");
  await addMoneyLine(page, "B", "USD", "0");
  await addMoneyLine(page, "C", "USD", "0");
  expect(await lineNames(page)).toEqual(["A", "B", "C"]);
  // a line's options live on its own screen, behind ⋯ in the top bar (PETTY-71); no dots on the rows
  await expect(page.getByRole("button", { name: /^Options for/ })).toHaveCount(0);
  // keyboard: open A, focus the ⋯ and go through the menu with Enter
  await page.getByRole("button", { name: "Open A" }).click();
  await page.getByRole("button", { name: "Options for A" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Move down" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Back" }).click();
  await expect.poll(() => lineNames(page)).toEqual(["B", "A", "C"]);
  await lineOption(page, "C", "Move up");
  await page.getByRole("button", { name: "Back" }).click();
  await expect.poll(() => lineNames(page)).toEqual(["B", "C", "A"]);
  // reload keeps the order (it was written to the document)
  await page.reload();
  await expect.poll(() => lineNames(page)).toEqual(["B", "C", "A"]);
  // rename + relabel currency: the number does not change (exponent is pinned)
  await lineOption(page, "A", "Rename");
  await page.getByLabel("Name", { exact: true }).fill("Alpha");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  await page.getByRole("button", { name: "Options for Alpha" }).click();
  await page.getByRole("button", { name: "Change currency" }).click();
  await page.getByLabel("Currency", { exact: true }).fill("jpy");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("line-balance")).toHaveText("10.00");
  // type is locked once the line has entries; B has none
  await page.getByRole("button", { name: "Options for Alpha" }).click();
  await expect(page.getByRole("button", { name: "Change type" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("line-row").filter({ hasText: "Alpha" })).toContainText("10.00 JPY");
  await page.getByRole("button", { name: "Open B" }).click();
  await page.getByRole("button", { name: "Options for B" }).click();
  await expect(page.getByRole("button", { name: "Change type" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  // delete with history count: back on the drawer afterwards
  await lineOption(page, "Alpha", "Delete item");
  await expect(page.getByRole("dialog")).toContainText("1 entry of history");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => lineNames(page)).toEqual(["B", "C"]);
  // delete drawer (owner) with the confirmation naming it
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByRole("button", { name: "Delete drawer" }).click();
  await expect(page.getByRole("dialog")).toContainText("Delete “Desk”");
  // second confirmation (PETTY-62): Delete stays off until the drawer's name is typed; case and spacing do not matter
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await expect(page.getByTestId("challenge-text")).toContainText("Desk"); // the text to type is shown, with a Copy button (PETTY-74)
  await expect(page.getByTestId("challenge-text").getByRole("button", { name: "Copy" })).toBeVisible();
  await page.getByTestId("delete-drawer-name").fill("Des");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await page.getByTestId("delete-drawer-name").fill(" desk ");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
});

test("photo: a JPEG with GPS Exif is re-encoded; the stored photo has no Exif and is under 300 KB", async ({ page }) => {
  const user = await signupWithKeys("hal");
  await loginAndUnlock(page, user);
  const id = await addDrawer(page, "Garage");
  // a real 1200×800 JPEG from a canvas (so it must be downscaled), with a GPS Exif segment spliced in
  const plain = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 1200; c.height = 800;
    const ctx = c.getContext("2d")!; ctx.fillStyle = "#c33"; ctx.fillRect(0, 0, 1200, 800); ctx.fillStyle = "#3c3"; ctx.fillRect(100, 100, 600, 400);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.95));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  await page.locator("#photo-input").setInputFiles({ name: "gps.jpg", mimeType: "image/jpeg", buffer: jpegWithGpsExif(plain) });
  await expect(page.getByTestId("drawer-photo")).toBeVisible();
  const check = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="drawer-photo"]')!;
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    let hasExif = false;
    for (let i = 0; i + 5 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78) hasExif = true;
    const dims = await new Promise<{ w: number; h: number }>((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.src = img.src; });
    return { size: bytes.length, hasExif, isJpeg: bytes[0] === 0xff && bytes[1] === 0xd8, ...dims };
  });
  expect(check.isJpeg).toBe(true);
  expect(check.w).toBe(1000);
  expect(check.h).toBe(667);
  expect(check.hasExif).toBe(false);
  expect(check.size).toBeLessThan(300 * 1024);
  // stored as its own encrypted row: the API says the drawer has a photo, the document does not carry it
  const api = await apiClient(user);
  const boot = (await api.call("GET", "/bootstrap")).json as { drawers: { id: string; has_photo: boolean }[] };
  expect(boot.drawers.find((d) => d.id === id)?.has_photo).toBe(true);
  // PETTY-243: Settings shows the storage this person uses against the instance's quota (500 MB in e2e)
  const storage = (await api.call("GET", "/me/storage")).json as { used_bytes: number; quota_bytes: number };
  expect(storage.quota_bytes).toBe(500 * 1024 * 1024);
  expect(storage.used_bytes).toBeGreaterThan(check.size);
  await openSettings(page);
  await expect(page.getByTestId("storage-used")).toHaveText(/^[\d.,]+ MB of 500 MB used$/);
  await page.goBack();
  // PETTY-122: the photo controls live in the drawer options
  await page.getByRole("button", { name: "Drawer options" }).click();
  await expect(page.getByRole("dialog").getByTestId("drawer-photo-add")).toHaveText("Change photo");
  await page.getByRole("dialog").getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByTestId("drawer-photo")).toBeHidden();
});

test("two users edit the same drawer: a stale-version write is retried and both edits survive; concurrent reorders lose no line", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await addDrawer(pageA, "Shared");
  await addMoneyLine(pageA, "One", "PLN", "0");
  await addMoneyLine(pageA, "Two", "PLN", "0");
  await addMoneyLine(pageA, "Three", "PLN", "0");
  await shareViaApi(alice, id, bob, "write");
  await loginAndUnlock(pageB, bob);
  await pageB.getByRole("button", { name: "Open Shared" }).click();
  await expect.poll(() => lineNames(pageB)).toEqual(["One", "Two", "Three"]);
  // both loaded version N. Alice renames One; Bob (still on N) renames Two → 409 → refetch → re-apply → both present.
  await lineOption(pageA, "One", "Rename");
  await pageA.getByLabel("Name", { exact: true }).fill("Uno");
  await pageA.getByRole("button", { name: "Save" }).click();
  await pageA.getByRole("button", { name: "Back" }).click();
  await expect.poll(() => lineNames(pageA)).toEqual(["Uno", "Two", "Three"]);
  await lineOption(pageB, "Two", "Rename");
  await pageB.getByLabel("Name", { exact: true }).fill("Dos");
  await pageB.getByRole("button", { name: "Save" }).click();
  await pageB.getByRole("button", { name: "Back" }).click();
  await expect.poll(() => lineNames(pageB)).toEqual(["Uno", "Dos", "Three"]);
  await pageA.reload();
  await expect.poll(() => lineNames(pageA)).toEqual(["Uno", "Dos", "Three"]);
  // simultaneous reorders
  await Promise.all([
    (async () => { await lineOption(pageA, "Uno", "Move down"); await pageA.getByRole("button", { name: "Back" }).click(); })(),
    (async () => { await lineOption(pageB, "Three", "Move up"); await pageB.getByRole("button", { name: "Back" }).click(); })(),
  ]);
  // Each click applies locally first, then posts (the loser of the race retries after a 409). Wait for both
  // local orders, then reload until both pages read the same server order — a reload that races the retry is stale, not wrong.
  // (the drawer's list is back — on the line screen there is no list, which "not the old order" would also match)
  const moved = (page: Page) => async () => { const n = await lineNames(page); return n.length === 3 && n.join() !== "Uno,Dos,Three"; };
  await expect.poll(moved(pageA)).toBe(true);
  await expect.poll(moved(pageB)).toBe(true);
  let a: string[] = [];
  await expect.poll(async () => {
    await pageA.reload(); await pageB.reload();
    await Promise.all([expect.poll(() => lineNames(pageA)).toHaveLength(3), expect.poll(() => lineNames(pageB)).toHaveLength(3)]);
    const [x, y] = await Promise.all([lineNames(pageA), lineNames(pageB)]);
    a = x;
    return x.join() === y.join();
  }, { timeout: 30_000, intervals: [1000] }).toBe(true);
  expect([...a].sort()).toEqual(["Dos", "Three", "Uno"]);
  // Bob sees who edited last
  await expect(pageB.getByText(/Last edited by/)).toBeVisible();
  await ctxA.close(); await ctxB.close();
});

test("a drawer whose ciphertext was tampered with shows as degraded and the total is marked incomplete", async ({ page }) => {
  const user = await signupWithKeys("ivy");
  await loginAndUnlock(page, user);
  const good = await addDrawer(page, "Good");
  await addMoneyLine(page, "Cash", "EUR", "5");
  await page.getByRole("button", { name: "Back" }).click();
  const bad = await addDrawer(page, "Bad");
  await addMoneyLine(page, "Cash", "EUR", "7");
  await corruptDocument(bad);
  await page.goto("/");
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Good" })).toContainText("5.00 EUR");
  await expect(page.getByTestId("drawer-row").nth(1)).toContainText("This drawer could not be opened.");
  await expect(page.getByTestId("totals-incomplete")).toBeVisible();
  await expect(page.getByTestId("home-totals")).toContainText("5.00 EUR");
  void good;
});

test("drag reorder: neighbours slide aside during the drag and the drop commits the new order", async ({ page }) => {
  const user = await signupWithKeys("dragger");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Sliding");
  await addMoneyLine(page, "One", "PLN", "0");
  await addMoneyLine(page, "Two", "PLN", "0");
  await addMoneyLine(page, "Three", "PLN", "0");
  await expect.poll(() => lineNames(page)).toEqual(["One", "Two", "Three"]);
  const handle = page.getByRole("button", { name: /^Move One:/ });
  const box = (await handle.boundingBox())!;
  const second = page.locator("[data-line-id]").nth(1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // drag past the middle of the second card (cards grew with PETTY-64, so the distance is measured, not fixed)
  const secondBox = (await second.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, secondBox.y + secondBox.height / 2 + 12, { steps: 6 });
  // mid-drag: the second card has slid up to open the slot; the dragged card is marked
  await expect(second).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, -\d/); // slid straight up, no side shift
  await expect(page.locator("[data-line-id]").nth(0)).toHaveClass(/dragging/);
  await page.mouse.up();
  await expect.poll(() => lineNames(page)).toEqual(["Two", "One", "Three"]);
  // transforms are cleared after the drop
  await expect(second).not.toHaveClass(/dragging/);
});

test("home search: one word finds the matching lines in every drawer, shown under their drawer (PETTY-47)", async ({ page }) => {
  const user = await signupWithKeys("seeker");
  await loginAndUnlock(page, user);
  const addSingle = async (name: string, text: string) => {
    await page.getByRole("button", { name: "Add item" }).click();
    await page.getByRole("button", { name: "Single item" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Text (optional)").fill(text);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  };
  await addDrawer(page, "Kitchen");
  await addSingle("Passport", "expires 2031");
  await addMoneyLine(page, "Groceries", "EUR", "20");
  await page.getByRole("button", { name: "Back" }).click();
  await addDrawer(page, "Safe");
  await addSingle("Passport (kids)", "in the blue box");
  await page.getByRole("button", { name: "Back" }).click();
  await addDrawer(page, "Car");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-row")).toHaveCount(3);
  // open the search, type, wait for the debounce
  await page.getByTestId("home-search-toggle").click();
  await expect(page.getByLabel("Search drawers, places, items and tags")).toBeFocused();
  await page.getByLabel("Search drawers, places, items and tags").fill("PASS");
  await expect(page.getByTestId("search-count")).toHaveText("2 items in 2 drawers");
  const groups = page.getByTestId("drawer-group");
  // PETTY-117: search mode is the results only — the drawers that answer, no totals, chips or non-matching rows
  await expect(groups).toHaveCount(2);
  await expect(groups.filter({ hasText: "Kitchen" }).getByTestId("search-hit")).toHaveText(["Passportexpires 2031"]);
  await expect(groups.filter({ hasText: "Safe" }).getByTestId("search-hit")).toHaveText(["Passport (kids)in the blue box"]);
  await expect(groups.filter({ hasText: "Car" })).toHaveCount(0);
  await expect(page.getByTestId("home-totals")).toHaveCount(0);
  await expect(page.getByTestId("drawers-header")).toHaveCount(0);
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))).toEqual([]);
  // accent-insensitive; narrows to one drawer
  await page.getByLabel("Search drawers, places, items and tags").fill("gróc");
  await expect(page.getByTestId("search-count")).toHaveText("1 item in 1 drawer");
  await expect(page.getByTestId("search-hit")).toHaveText(["Groceries20.00 EUR"]);
  // a hit opens the line
  await page.getByTestId("search-hit").click();
  await expect(page.getByTestId("line-balance")).toHaveText("20.00");
  await page.getByRole("button", { name: "Back" }).click();
  // Escape clears and hides the field; the list is back to normal
  await page.getByTestId("home-search-toggle").click();
  await page.getByLabel("Search drawers, places, items and tags").fill("zzz");
  await expect(page.getByTestId("search-count")).toHaveText("Nothing matches.");
  await page.getByLabel("Search drawers, places, items and tags").press("Escape");
  await expect(page.getByTestId("home-search")).toHaveCount(0);
  await expect(page.getByTestId("drawer-group")).toHaveCount(0);
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Car" })).not.toHaveClass(/dim/);
});

test("places: an ordered path groups drawers under a room, chips drill down, the total narrows, a shared drawer carries its place, a switch hides places (PETTY-52/58/59)", async ({ browser }) => {
  const alice = await signupWithKeys("alice");
  const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageA, alice);
  // The place is picked from the tree (PETTY-66); a missing level is typed into the "new place inside …" field,
  // which creates it under the drawer's current place and selects it. Picking closes the sheet, so one level per round.
  const setPlace = async (segments: string[]) => {
    for (const seg of segments) {
      await pageA.getByRole("button", { name: "Drawer options" }).click();
      await pageA.getByTestId("drawer-tags").click();
      const picker = pageA.getByTestId("drawer-place-picker");
      const existing = picker.getByTestId("place-option").filter({ hasText: new RegExp(`^${seg}$`, "i") });
      if (await existing.count()) await existing.first().click();
      else { await picker.getByTestId("place-new").fill(seg); await picker.getByRole("button", { name: "Add place" }).click(); }
      await expect(pageA.getByRole("dialog")).toBeHidden();
    }
  };
  await addDrawer(pageA, "Kitchen"); await addMoneyLine(pageA, "Cash", "PLN", "100"); await setPlace(["House"]); await pageA.getByRole("button", { name: "Back" }).click();
  // shed › Outside: two levels of the tree, created on the way
  const shedId = await addDrawer(pageA, "Shed box"); await addMoneyLine(pageA, "Coins", "PLN", "40"); await setPlace(["shed", "Outside"]); await pageA.getByRole("button", { name: "Back" }).click();
  await addDrawer(pageA, "Car"); await addMoneyLine(pageA, "Parking", "EUR", "20"); await pageA.getByRole("button", { name: "Back" }).click();
  // chips: All + the rooms (first word) with their drawer counts; "Outside" is not a room
  const bar = pageA.getByTestId("tag-bar");
  const chips = bar.locator("button.tag-chip:not(.tag-edit)"); // the pencil at the end opens the Places editor
  await expect(chips).toHaveText(["All3", "House1", "shed1"]);
  // grouped view: one section per room with a subtotal; each drawer ONCE; the deeper drawer sits under a sub-place label
  const groups = pageA.getByTestId("tag-group");
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0)).toContainText("House");
  await expect(groups.nth(0).getByTestId("drawer-row")).toContainText("Kitchen");
  await expect(groups.nth(0).getByRole("heading", { level: 2 })).toHaveAccessibleName("House, 1 drawer"); // PETTY-132
  await expect(groups.nth(0)).toContainText("100.00 PLN");
  await expect(groups.nth(1)).toContainText("shed");
  await expect(groups.nth(1).getByTestId("sub-place")).toHaveText("Outside");
  await expect(groups.nth(1).getByTestId("drawer-row")).toHaveCount(1);
  await expect(groups.nth(2)).toContainText("No place");
  await expect(groups.nth(2).getByTestId("drawer-row")).toContainText("Car");
  await expect(pageA.getByTestId("drawer-row")).toHaveCount(3);
  await expect(pageA.getByTestId("row-place")).toHaveCount(0); // the group header says it; no chips on the rows
  // select a room: its drawers rise to the top, the rest sink below greyed (PETTY-55); the TOTAL narrows
  await bar.getByRole("button", { name: /^shed/ }).click();
  await expect(pageA.getByTestId("tag-groups")).toHaveCount(0);
  // PETTY-116: only the selection is listed; the rest waits behind one labelled, collapsed row
  await expect(pageA.getByTestId("drawer-row")).toHaveCount(1);
  await expect(pageA.getByTestId("drawer-row").nth(0)).toContainText("Shed box");
  await expect(pageA.getByTestId("drawer-row").nth(0)).not.toHaveClass(/dim/);
  // inside the selection the deeper drawer is shifted right under its sub-place label, no chip on the row (PETTY-60)
  await expect(pageA.getByTestId("sub-place")).toHaveText("Outside");
  await expect(pageA.getByTestId("row-place")).toHaveCount(0);
  const others = pageA.getByTestId("other-drawers");
  await expect(others.getByRole("button", { expanded: false })).toContainText("Other drawers");
  await others.getByRole("button").click();
  await expect(pageA.getByTestId("drawer-row")).toHaveCount(3);
  await expect(pageA.getByTestId("drawer-row").nth(1)).toHaveClass(/dim/);
  await expect(pageA.getByTestId("drawer-row").nth(2)).toHaveClass(/dim/);
  await others.getByRole("button", { expanded: true }).click();
  await expect(pageA.getByTestId("drawer-row")).toHaveCount(1);
  await expect(pageA.getByTestId("home-totals")).toContainText("Total value · shed");
  await expect(pageA.getByTestId("totals-across")).toHaveText("Across 1 drawer"); // the selection, not every drawer
  await expect(pageA.getByTestId("home-totals").getByRole("listitem")).toHaveText(["40.00 PLN"]);
  // the chips now show the selected room and the next level below it; tapping goes one level down
  await expect(chips).toHaveText(["All3", "shed1", "Outside1"]);
  await bar.getByRole("button", { name: /^Outside/ }).click();
  await expect(pageA.getByTestId("home-totals")).toContainText("Total value · shed › Outside");
  await expect(bar.getByRole("button", { name: /^Outside/ })).toHaveAttribute("aria-pressed", "true");
  // search works inside the selected place
  await pageA.getByTestId("home-search-toggle").click();
  await pageA.getByLabel("Search drawers, places, items and tags").fill("cash");
  await expect(pageA.getByTestId("search-count")).toHaveText("Nothing matches.");
  await pageA.getByLabel("Search drawers, places, items and tags").press("Escape");
  // tapping a selected chip goes back above it
  await bar.getByRole("button", { name: /^shed/ }).click();
  await expect(pageA.getByTestId("tag-group")).toHaveCount(3);
  // a place can be given when adding a drawer (PETTY-54)
  await pageA.getByRole("button", { name: "Add drawer" }).click();
  await pageA.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Attic");
  await pageA.getByTestId("add-place-picker").getByTestId("place-option").filter({ hasText: /^House$/ }).click();
  await pageA.getByRole("button", { name: "Save" }).click();
  await expect(pageA.getByRole("heading", { name: "Attic" })).toBeVisible();
  await pageA.getByRole("button", { name: "Back" }).click();
  await expect(bar.getByRole("button", { name: /^House/ })).toHaveText("House2");
  // Settings: places off -> one plain list, no chips, no groups; on again -> back
  await openSettings(pageA);
  await pageA.getByTestId("places-switch").uncheck();
  await pageA.getByRole("button", { name: "Back" }).click();
  await expect(pageA.getByTestId("tag-bar")).toHaveCount(0);
  await expect(pageA.getByTestId("tag-groups")).toHaveCount(0);
  await expect(pageA.getByTestId("drawer-row")).toHaveCount(4);
  await expect(pageA.getByTestId("row-place")).toHaveCount(0);
  await openSettings(pageA);
  await pageA.getByTestId("places-switch").check();
  await pageA.getByRole("button", { name: "Back" }).click();
  await expect(pageA.getByTestId("tag-group")).toHaveCount(3);
  // the place travels with the shared drawer (it lives in the encrypted document)
  await shareViaApi(alice, shedId, bob, "read");
  await loginAndUnlock(pageB, bob);
  await expect(pageB.getByTestId("tag-bar").locator("button.tag-chip:not(.tag-edit)")).toHaveText(["All1", "shed1"]);
  await expect(pageB.getByTestId("sub-place")).toHaveText("Outside");
  await ctxA.close(); await ctxB.close();
});

test("drawer screen (PETTY-64): icons for the drawer and a line, line tags with a filter, a line switched out of the total changes both totals and the home screen", async ({ page }) => {
  const u = await signupWithKeys("pete");
  await loginAndUnlock(page, u);
  await addDrawer(page, "Kitchen");
  await addMoneyLine(page, "Cash", "PLN", "4000");
  await addMoneyLine(page, "Gold coins", "PLN", "10000");
  // header card: default icon, edited-by line; one total box while nothing is excluded
  await expect(page.getByTestId("drawer-head")).not.toContainText("Kitchen"); // the name is the top bar's title, not repeated (PETTY-81)
  await expect(page.getByTestId("drawer-head")).toContainText("Last edited by pete ·");
  await expect(page.getByTestId("drawer-head").locator(".tile")).toHaveAttribute("data-icon", "archive");
  await expect(page.getByTestId("total-included")).toContainText("14,000.00 PLN");
  await expect(page.getByTestId("total-included")).toContainText("2 items · 1 currency");
  await expect(page.getByTestId("total-all")).toHaveCount(0);
  await expect(page.getByTestId("status-bar")).toHaveCount(0);
  // drawer icon
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-icon").click();
  await page.getByTestId("icon-picker").getByRole("button", { name: "Kitchen" }).click();
  await expect(page.getByTestId("drawer-head").locator(".tile")).toHaveAttribute("data-icon", "kitchen");
  // line icon + tags
  const gold = page.getByTestId("line-row").filter({ hasText: "Gold coins" });
  await lineOption(page, "Gold coins", "Icon");
  await page.getByTestId("line-icon-picker").getByRole("button", { name: "Valuables" }).click();
  await page.getByRole("button", { name: "Options for Gold coins" }).click();
  await page.getByTestId("line-tags-btn").click();
  await pickTags(page, ["valuables", "Household"]);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(gold.locator(".tile")).toHaveAttribute("data-icon", "gem");
  await expect(gold.getByTestId("line-tags")).toHaveText("valuablesHousehold");
  await lineOption(page, "Cash", "Tags");
  // PETTY-147: the drawer's tags are chips; "household" is the existing "Household", not a new tag
  await expect(page.getByTestId("tag-picker").getByRole("button")).toContainText(["Household", "valuables"]);
  await pickTags(page, ["household", "cash"]);
  await page.getByRole("button", { name: "Back" }).click();
  // tag filter: chips with counts (Household folded onto one spelling), one tag narrows the list
  await expect(page.getByTestId("line-tag-bar").getByRole("button")).toHaveText(["All tags", "cash", "Household", "valuables", "Manage tags"]);
  await page.getByTestId("line-tag-bar").getByRole("button", { name: /^cash/ }).click();
  await expect(page.getByTestId("line-row")).toHaveCount(1);
  await expect(page.getByTestId("line-row")).toContainText("Cash");
  await page.getByTestId("line-tag-bar").getByRole("button", { name: "All tags" }).click();
  await expect(page.getByTestId("line-row")).toHaveCount(2);
  // switch Gold coins out of the total: two boxes, status chips, the row says so, the amount is muted
  await page.getByRole("button", { name: "Open Gold coins" }).click();
  await page.getByRole("button", { name: "Options for Gold coins" }).click();
  await page.getByTestId("line-counted-switch").click(); // the switch flips once the document write lands
  await expect(page.getByTestId("line-counted-switch")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(gold.getByTestId("line-counted")).toHaveText("Not in total");
  await expect(page.getByTestId("total-included")).toContainText("4,000.00 PLN");
  await expect(page.getByTestId("total-included")).toContainText("1 of 2 items counts toward this total");
  await expect(page.getByTestId("total-all")).toContainText("14,000.00 PLN");
  await expect(page.getByTestId("total-excluded")).toContainText("10,000.00 PLN");
  await expect(page.getByTestId("status-bar").getByRole("button")).toHaveText(["All items2", "In total1", "Not in total1"]);
  await page.getByTestId("status-bar").getByRole("button", { name: /^Not in total/ }).click();
  await expect(page.getByTestId("line-row")).toHaveCount(1);
  await expect(page.getByTestId("line-row")).toContainText("Gold coins");
  // the home screen counts only the included line, on the card and in the total
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-row").getByTestId("row-amount")).toHaveText("4,000.00 PLN");
  await expect(page.getByTestId("home-totals").getByRole("listitem")).toHaveText(["4,000.00 PLN"]);
  await expect(page.getByTestId("drawer-row").locator(".tile")).toHaveAttribute("data-icon", "kitchen");
});

test("places editor (PETTY-66): add, nest, rename, move and delete places; the drawers' paths follow", async ({ page }) => {
  const u = await signupWithKeys("ola");
  await loginAndUnlock(page, u);
  await addDrawer(page, "Cash box"); await page.getByRole("button", { name: "Back" }).click();
  // Settings -> Manage places; build clubhouse › pool area › locker 12
  await openSettings(page);
  await page.getByTestId("manage-places").click();
  await expect(page.getByTestId("places-empty")).toBeVisible();
  const add = async (name: string) => { await page.getByRole("dialog").getByLabel("Name").fill(name); await page.getByRole("dialog").getByRole("button", { name: "Save" }).click(); await expect(page.getByRole("dialog")).toBeHidden(); };
  await page.getByTestId("place-add-root").click(); await add("clubhouse");
  await page.getByRole("button", { name: "Options for clubhouse" }).click(); await page.getByTestId("place-add-inside").click(); await add("pool area");
  await page.getByRole("button", { name: "Options for pool area" }).click(); await page.getByTestId("place-add-inside").click(); await add("locker 12");
  await expect(page.getByTestId("place-name")).toHaveText(["clubhouse", "pool area", "locker 12"]);
  await expect(page.getByTestId("place-row").nth(2)).toHaveAttribute("data-depth", "2");
  // a duplicate sibling is refused
  await page.getByRole("button", { name: "Options for clubhouse" }).click(); await page.getByTestId("place-add-inside").click();
  await page.getByRole("dialog").getByLabel("Name").fill("Pool Area"); await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toContainText("already here");
  await page.keyboard.press("Escape");
  // folding a branch hides what is under it
  await page.getByRole("button", { name: "Collapse clubhouse" }).click();
  await expect(page.getByTestId("place-name")).toHaveText(["clubhouse"]);
  await page.getByRole("button", { name: "Expand clubhouse" }).click();
  // put the drawer at the deepest node through the picker
  await page.getByRole("button", { name: "Back" }).click(); await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Open Cash box" }).click();
  await page.getByRole("button", { name: "Drawer options" }).click(); await page.getByTestId("drawer-tags").click();
  await page.getByTestId("drawer-place-picker").getByTestId("place-option").filter({ hasText: /^locker 12$/ }).click();
  await page.getByRole("button", { name: "Drawer options" }).click();
  await expect(page.getByTestId("drawer-tags")).toContainText("clubhouse › pool area › locker 12");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("sub-place")).toHaveText("pool area › locker 12");
  // rename the middle node: the drawer's path follows
  await page.getByTestId("edit-places").click();
  await expect(page.getByTestId("place-count")).toHaveText(["1 drawer", "1 drawer", "1 drawer"]);
  await page.getByTestId("place-name").filter({ hasText: "pool area" }).click();
  await add("pool");
  await expect(page.getByTestId("place-name")).toHaveText(["clubhouse", "pool", "locker 12"]);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("sub-place")).toHaveText("pool › locker 12");
  // move locker 12 to the top level: the drawer's path follows
  await page.getByTestId("edit-places").click();
  await page.getByRole("button", { name: "Options for locker 12" }).click(); await page.getByTestId("place-move").click();
  await page.getByTestId("move-picker").getByTestId("place-option").filter({ hasText: /^Top level$/ }).click();
  await page.getByTestId("place-move-confirm").click();
  await expect(page.getByTestId("place-name")).toHaveText(["clubhouse", "pool", "locker 12"]);
  await expect(page.getByTestId("place-row").nth(2)).toHaveAttribute("data-depth", "0");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("tag-bar").locator("button.tag-chip:not(.tag-edit)")).toHaveText(["All1", "locker 121"]);
  // delete locker 12: the drawer moves up (to the top level = no place); empty places stay in the tree
  await page.getByTestId("edit-places").click();
  await page.getByRole("button", { name: "Options for locker 12" }).click(); await page.getByTestId("place-delete").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("place-name")).toHaveText(["clubhouse", "pool"]);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("tag-bar")).toHaveCount(0); // no drawer carries a place any more
});

test("places editor (PETTY-67/68): plus and minus on a row; drag like the drawer's lines — up/down reorders, the slot's level nests, left takes a row out", async ({ page }) => {
  const u = await signupWithKeys("ula");
  await loginAndUnlock(page, u);
  await addDrawer(page, "Tin"); await page.getByRole("button", { name: "Back" }).click();
  await openSettings(page);
  await page.getByTestId("manage-places").click();
  const add = async (name: string) => { await page.getByRole("dialog").getByLabel("Name").fill(name); await page.getByRole("dialog").getByRole("button", { name: "Save" }).click(); await expect(page.getByRole("dialog")).toBeHidden(); };
  await page.getByTestId("place-add-root").click(); await add("Clubhouse");
  await page.getByTestId("place-add-root").click(); await add("Home");
  // + on a row adds inside it
  await page.getByRole("button", { name: "Add a place inside Home" }).click(); await add("Kitchen");
  await page.getByRole("button", { name: "Add a place inside Clubhouse" }).click(); await add("Bar");
  const names = page.getByTestId("place-name");
  await expect(names).toHaveText(["Clubhouse", "Bar", "Home", "Kitchen"]);
  const row = (name: string) => page.getByTestId("place-row").filter({ has: names.filter({ hasText: new RegExp(`^${name}$`) }) });
  const slot = (await row("Bar").boundingBox())!.height + 4; // one row plus the gap
  // lift by the handle, move by (dx, dy) and release — the drawer's gesture
  const drag = async (name: string, dy: number, dx = 0) => {
    const h = (await page.getByRole("button", { name: new RegExp(`^Move ${name}:`) }).boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down(); await page.waitForTimeout(120);
    await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy, { steps: 8 });
    await expect(row(name)).toHaveClass(/dragging/);
    await page.mouse.up();
    await expect(row(name)).not.toHaveClass(/dragging/);
    await page.waitForTimeout(300); // let the spring settle before the next gesture, as a hand would
  };
  // Bar one slot down lands between Home and Kitchen: that slot is inside Home, so Bar becomes Home's first child
  await drag("Bar", slot * 1.2);
  await expect(names).toHaveText(["Clubhouse", "Home", "Bar", "Kitchen"]);
  await expect(row("Bar")).toHaveAttribute("data-depth", "1");
  // Kitchen one slot up: a reorder among Home's children
  await drag("Kitchen", -slot * 1.2);
  await expect(names).toHaveText(["Clubhouse", "Home", "Kitchen", "Bar"]);
  // Home to the top: the branch folds while held and travels as one row, then opens again
  await drag("Home", -slot * 1.2);
  await expect(names).toHaveText(["Home", "Kitchen", "Bar", "Clubhouse"]);
  await expect(row("Kitchen")).toHaveAttribute("data-depth", "1");
  await expect(row("Bar")).toHaveAttribute("data-depth", "1");
  // Clubhouse two slots up lands between Home and Kitchen: inside Home
  await drag("Clubhouse", -slot * 2.2);
  await expect(names).toHaveText(["Home", "Clubhouse", "Kitchen", "Bar"]);
  await expect(row("Clubhouse")).toHaveAttribute("data-depth", "1");
  // Clubhouse to the end, pulled left: out of Home, back at the top level
  await drag("Clubhouse", slot * 2.2, -60);
  await expect(names).toHaveText(["Home", "Kitchen", "Bar", "Clubhouse"]);
  await expect(row("Clubhouse")).toHaveAttribute("data-depth", "0");
  // − on a row deletes it (after the confirmation)
  await page.getByRole("button", { name: "Delete Clubhouse" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(names).toHaveText(["Home", "Kitchen", "Bar"]);
});

test("verification is optional (PETTY-83): the switch hides the Mark as checked bar, the history and the badges; on again brings them back", async ({ page }) => {
  const u = await signupWithKeys("vera");
  await loginAndUnlock(page, u);
  await addDrawer(page, "Tin"); await addMoneyLine(page, "Cash", "PLN", "10");
  await expect(page.getByTestId("verify-bar")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("verify-badge")).toHaveCount(1);
  await openSettings(page);
  // PETTY-127: a real switch whose accessible name is the title only; the hint is its description
  await expect(page.getByTestId("verification-switch")).toHaveAccessibleName("Show checks");
  await expect(page.getByTestId("verification-switch")).toHaveAccessibleDescription(/Mark as checked/);
  await page.getByTestId("verification-switch").uncheck();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("verify-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Tin" }).click();
  await expect(page.getByTestId("verify-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark as checked" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back" }).click();
  await openSettings(page);
  await page.getByTestId("verification-switch").check();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("verify-badge")).toHaveCount(1);
});

test("totals are optional (PETTY-84): the switch hides the Total value card, the drawer totals card and the in-total chips; balances stay", async ({ page }) => {
  const u = await signupWithKeys("toma");
  await loginAndUnlock(page, u);
  await addDrawer(page, "Tin"); await addMoneyLine(page, "Cash", "PLN", "10"); await addMoneyLine(page, "Coins", "PLN", "5");
  await page.getByRole("button", { name: "Open Coins" }).click(); await page.getByRole("button", { name: "Options for Coins" }).click();
  await page.getByTestId("line-counted-switch").click(); await expect(page.getByTestId("line-counted-switch")).not.toBeChecked(); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-totals")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home-totals")).toBeVisible();
  await openSettings(page);
  await page.getByTestId("totals-switch").uncheck();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home-totals")).toHaveCount(0);
  await expect(page.getByTestId("drawer-row").getByTestId("row-amount")).toHaveText("10.00 PLN"); // the card's own amount stays
  await page.getByRole("button", { name: "Open Tin" }).click();
  await expect(page.getByTestId("drawer-totals")).toHaveCount(0);
  await expect(page.getByTestId("status-bar")).toHaveCount(0);
  await expect(page.getByTestId("line-counted")).toHaveCount(0);
  await expect(page.getByTestId("line-row")).toHaveCount(2);
  await expect(page.getByTestId("line-row").first()).toContainText("10.00 PLN");
  await page.getByRole("button", { name: "Back" }).click();
  // PETTY-141: a drawer left out of the total says so only while Totals is on
  await addDrawer(page, "Club box");
  await page.getByRole("button", { name: "Drawer options" }).click(); await page.getByTestId("counted-switch").click(); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Club box" })).toBeVisible();
  await expect(page.getByTestId("not-in-total")).toHaveCount(0);
  await openSettings(page);
  await page.getByTestId("totals-switch").check();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("home-totals")).toBeVisible();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Club box" }).getByTestId("not-in-total")).toBeVisible();
});

test("Add drawer (PETTY-105): Enter in the new-place field adds the place and keeps the sheet; the drawer saves with that place", async ({ page }) => {
  const user = await signupViaApi("enter");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await page.getByRole("button", { name: "Add drawer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Tin");
  await dialog.getByTestId("place-new").fill("Kitchen");
  await dialog.getByTestId("place-new").press("Enter");
  // The place exists and is selected; the sheet is still open; no navigation happened.
  await expect(dialog.getByTestId("place-option").filter({ hasText: "Kitchen" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByTestId("place-new")).toHaveValue("");
  expect(page.url()).not.toContain("?");
  // A second, nested place through the button, then save.
  await dialog.getByTestId("place-new").fill("Shelf");
  await dialog.getByRole("button", { name: "Add place" }).click();
  await expect(dialog.getByTestId("place-option").filter({ hasText: "Shelf" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Tin" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  // Home groups by place: the Kitchen group holds the drawer, and its sub-place Shelf is a label inside the card (PETTY-121).
  await expect(page.getByRole("heading", { name: /Kitchen/ })).toBeVisible();
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Tin" }).getByTestId("sub-place")).toHaveText("Shelf");
});

test("keypad (PETTY-112): the physical keyboard types the amount — digits, decimal, Backspace, Enter reviews; the comment keeps its own keys", async ({ page }) => {
  const user = await signupViaApi("keys");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await addDrawer(page, "Desk");
  await addMoneyLine(page, "Cash", "PLN", "100");
  await page.getByTestId("line-row").first().click();
  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("4x0.55");
  await expect(page.getByTestId("amount-display")).toHaveText("40.55");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("amount-display")).toHaveText("40.5");
  // Digits typed into the comment stay there.
  await page.getByLabel("Comment (optional)").fill("");
  await page.getByLabel("Comment (optional)").type("bus 12");
  await expect(page.getByTestId("amount-display")).toHaveText("40.5");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("confirm-summary")).toContainText("−40.50");
  await expect(page.getByTestId("confirm-summary")).toContainText("bus 12");
});

test("reader (PETTY-115): a read-only member sees why there are no write controls, on the drawer and on a line", async ({ browser }) => {
  const alice = await signupWithKeys("alice"); const bob = await signupWithKeys("bob");
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await loginAndUnlock(pageA, alice);
  const id = await addDrawer(pageA, "Kitchen"); await addMoneyLine(pageA, "Cash", "PLN", "50");
  await shareViaApi(alice, id, bob, "read");
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  await loginAndUnlock(pageB, bob);
  await pageB.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).click();
  await expect(pageB.getByTestId("readonly-hint")).toHaveText("You can view this drawer, not change it. Ask alice for write access.");
  await expect(pageB.getByRole("button", { name: "Add item" })).toHaveCount(0);
  await pageB.getByTestId("line-row").first().click();
  await expect(pageB.getByTestId("line-balance")).toBeVisible();
  await expect(pageB.getByTestId("readonly-hint")).toBeVisible();
  await expect(pageB.getByRole("button", { name: "Withdraw" })).toHaveCount(0);
  // The owner never sees it.
  await expect(pageA.getByTestId("readonly-hint")).toHaveCount(0);
  await ctxA.close(); await ctxB.close();
});

test("add line (PETTY-124): the currency starts filled and quick chips set it; the drawer's own currency wins", async ({ page }) => {
  const user = await signupViaApi("cur");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await addDrawer(page, "Tin");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("EUR"); // en-GB, nothing used yet
  await page.getByTestId("currency-quick").getByRole("button", { name: "GBP" }).click();
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("GBP");
  await page.getByLabel("Name", { exact: true }).fill("Cash");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-name").filter({ hasText: "Cash" })).toBeVisible();
  // The next line in this drawer proposes the drawer's currency.
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("GBP");
  await expect(page.getByTestId("currency-quick").getByRole("button").first()).toHaveText("GBP");
});

test("keyboard reorder (PETTY-130): the drag handle moves a line with the arrow keys and announces the new position; the places editor too", async ({ page }) => {
  const user = await signupViaApi("keys2");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await addDrawer(page, "Desk");
  await addMoneyLine(page, "Alpha", "PLN", "1"); await addMoneyLine(page, "Beta", "PLN", "1"); await addMoneyLine(page, "Gamma", "PLN", "1");
  expect(await lineNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);
  await page.getByRole("button", { name: /Move Alpha/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => lineNames(page)).toEqual(["Beta", "Alpha", "Gamma"]);
  await expect(page.getByTestId("move-announce")).toHaveText("Alpha moved to position 2 of 3");
  await page.keyboard.press("End");
  await expect.poll(() => lineNames(page)).toEqual(["Beta", "Gamma", "Alpha"]);
  // places editor
  await page.getByRole("button", { name: "Back" }).click();
  await openSettings(page);
  await page.getByTestId("manage-places").click();
  for (const n of ["Room A", "Room B"]) {
    await page.getByTestId("place-add-root").click(); await page.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill(n); await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog")).toBeHidden(); await page.waitForTimeout(300); // let the user-document write land before the next one
  }
  await expect(page.getByTestId("place-name")).toHaveText(["Room A", "Room B"]);
  await page.getByRole("button", { name: /Move Room B/ }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("place-name")).toHaveText(["Room B", "Room A"]);
  await expect(page.getByTestId("move-announce")).toHaveText("Room B moved to position 1 of 2");
});

test("tags (PETTY-147): the picker toggles and adds, the limit shows, Manage tags renames (and merges) and removes a tag on every line", async ({ page }) => {
  const user = await signupViaApi("tagm");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await addDrawer(page, "Desk");
  await addMoneyLine(page, "Cash", "PLN", "1"); await addMoneyLine(page, "Coins", "PLN", "1");
  await page.getByRole("button", { name: "Open Cash" }).click(); await page.getByRole("button", { name: "Options for Cash" }).click(); await page.getByTestId("line-tags-btn").click();
  const picker = page.getByTestId("tag-picker");
  await expect(picker.getByText("No tags yet")).toBeVisible();
  await pickTags(page, ["food", "cash", "Food"]); // "Food" is the same tag as "food"
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("line-row").filter({ has: page.getByTestId("line-name").getByText("Cash", { exact: true }) }).getByTestId("line-tags")).toHaveText("foodcash");
  // the second line picks from the chips; the counter shows the limit
  await page.getByRole("button", { name: "Open Coins" }).click(); await page.getByRole("button", { name: "Options for Coins" }).click(); await page.getByTestId("line-tags-btn").click();
  await expect(picker.getByRole("button", { name: "cash" })).toHaveAttribute("aria-pressed", "false");
  await picker.getByRole("button", { name: "cash" }).click();
  await expect(picker.getByText("1 of 5 tags")).toBeVisible();
  await picker.getByLabel("New tag").fill("household envelope tin"); await picker.getByLabel("New tag").press("Enter");
  await picker.getByTestId("tag-save").click();
  await page.getByRole("button", { name: "Back" }).click();
  // Manage tags: rename the typo onto an existing tag (merge), then remove one everywhere
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("manage-tags").click();
  const mgr = page.getByTestId("tag-manager");
  await expect(mgr.getByTestId("tag-manager-row")).toHaveCount(3);
  // PETTY-155: each row names the items, by drawer
  await expect(mgr.getByTestId("tag-manager-row").filter({ hasText: /^cash/ }).getByTestId("tag-manager-summary")).toHaveText("Desk: Cash, Coins");
  // PETTY-148: a long name wraps; the rows stay inside the sheet and nothing scrolls sideways
  await expect(mgr.getByRole("button", { name: /^household envelope tin,/ })).toBeInViewport({ ratio: 1 });
  const sheet = page.getByRole("dialog");
  expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  for (const row of await mgr.getByTestId("tag-manager-row").all()) {
    const box = (await row.boundingBox())!; const sb = (await sheet.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(sb.x + sb.width);
  }
  const tagsOf = (name: string) => page.getByTestId("line-row").filter({ has: page.getByTestId("line-name").getByText(name, { exact: true }) }).getByTestId("line-tags");
  const dialog = page.getByRole("dialog");
  const detail = page.getByTestId("tag-detail");
  const closeManager = () => dialog.getByRole("button", { name: "Close" }).click();
  // rename onto an existing tag: asked first, then merged
  await openTag(page, "household envelope tin");
  await expect(detail.getByTestId("tag-detail-drawer")).toHaveText(["DeskCoins"]);
  await detail.getByTestId("tag-detail-rename").click();
  await dialog.getByRole("textbox", { name: "New name" }).fill("food");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toContainText("“food” already exists. Merge “household envelope tin” into it?");
  await dialog.getByRole("button", { name: "Merge" }).click();
  await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("food");
  await expect(detail.getByRole("button", { name: /^Open .* in Desk$/ })).toHaveText(["Cash", "Coins"]);
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(mgr.getByTestId("tag-manager-row")).toHaveCount(2);
  await expect(tagsOf("Coins")).toHaveText("cashfood");
  await closeManager();
  // PETTY-149: the tag bar's own button opens the same manager
  await page.getByTestId("line-tag-bar").getByRole("button", { name: "Manage tags" }).click();
  await openTag(page, "cash");
  await detail.getByTestId("tag-detail-remove").click();
  await expect(dialog).toContainText("Remove “cash” from 2 items? The items stay.");
  await dialog.getByRole("button", { name: "Remove tag" }).click();
  await expect(mgr.getByTestId("tag-manager-row")).toHaveCount(1);
  await closeManager();
  await expect(tagsOf("Cash")).toHaveText("food");
  await expect(tagsOf("Coins")).toHaveText("food");
  await expect(page.getByTestId("line-tag-bar").getByRole("button")).toHaveText(["All tags", "food", "Manage tags"]);
  // PETTY-150: after the last tag goes, Manage tags stays in Drawer options and points to New tag
  await page.getByTestId("line-tag-bar").getByRole("button", { name: "Manage tags" }).click();
  await openTag(page, "food");
  await detail.getByTestId("tag-detail-remove").click();
  await dialog.getByRole("button", { name: "Remove tag" }).click();
  await expect(page.getByTestId("tag-manager-empty")).toContainText("New tag");
  await closeManager();
  // PETTY-153: no tags left, the bar stays with only its Manage tags button
  await expect(page.getByTestId("line-tag-bar").getByRole("button")).toHaveText(["Manage tags"]);
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("manage-tags").click();
  await expect(page.getByTestId("tag-manager-empty")).toBeVisible();
  // PETTY-151/152: a tag is made right here; it needs a name, its items can wait
  await page.getByTestId("tag-manager-new").click();
  const items = page.getByTestId("tag-items");
  await items.getByTestId("tag-items-save").click();
  await expect(items.getByRole("alert")).toHaveText("A tag needs a name.");
  await items.getByLabel("Tag name").fill("  spare   cash ");
  await items.getByTestId("tag-items-save").click();
  await expect(items).toHaveCount(0);
  await expect(mgr.getByTestId("tag-manager-summary")).toHaveText(["No items yet"]);
  // Choose items: put it on Coins, then move it to Cash; the detail follows
  await openTag(page, "spare cash");
  await expect(page.getByTestId("tag-detail-empty")).toBeVisible();
  await detail.getByTestId("tag-detail-choose").click();
  await items.getByLabel("Coins in Desk").check();
  await items.getByTestId("tag-items-save").click();
  await expect(detail.getByRole("button", { name: /^Open .* in Desk$/ })).toHaveText(["Coins"]);
  await detail.getByTestId("tag-detail-choose").click();
  await expect(items.getByLabel("Coins in Desk")).toBeChecked();
  await items.getByLabel("Cash in Desk").check();
  await items.getByLabel("Coins in Desk").uncheck();
  await items.getByTestId("tag-items-save").click();
  await expect(detail.getByRole("button", { name: /^Open .* in Desk$/ })).toHaveText(["Cash"]);
  // an item opens its drawer filtered by the tag
  await detail.getByRole("button", { name: "Open Cash in Desk" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("line-tag-bar").getByRole("button", { name: "spare cash" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => lineNames(page)).toEqual(["Cash"]);
  await expect(page).not.toHaveURL(/tag=/);
  await expect(tagsOf("Cash")).toHaveText("spare cash");
});

test("tags per person (PETTY-152): one list across drawers, kept without items, renamed from Settings in every drawer", async ({ page }) => {
  const user = await signupViaApi("tagu");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await addDrawer(page, "Kitchen");
  await addMoneyLine(page, "Jar", "PLN", "1");
  await page.getByRole("button", { name: "Open Jar" }).click(); await page.getByRole("button", { name: "Options for Jar" }).click(); await page.getByTestId("line-tags-btn").click();
  await pickTags(page, ["groceries"]);
  await page.getByRole("button", { name: "Back" }).click();
  // a tag made in the manager with no items yet
  await page.getByTestId("line-tag-bar").getByRole("button", { name: "Manage tags" }).click();
  await page.getByTestId("tag-manager-new").click();
  await page.getByTestId("tag-items").getByLabel("Tag name").fill("emergency");
  await page.getByTestId("tag-items-save").click();
  await expect(page.getByTestId("tag-manager-row")).toHaveCount(2);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  // another drawer: the picker offers both tags
  await page.goto("/");
  await addDrawer(page, "Office");
  await addMoneyLine(page, "Petty box", "PLN", "1");
  await page.getByRole("button", { name: "Open Petty box" }).click(); await page.getByRole("button", { name: "Options for Petty box" }).click(); await page.getByTestId("line-tags-btn").click();
  const picker = page.getByTestId("tag-picker");
  await expect(picker.getByRole("button", { name: "emergency" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "groceries" })).toBeVisible();
  await picker.getByRole("button", { name: "groceries" }).click();
  await picker.getByTestId("tag-save").click();
  await page.getByRole("button", { name: "Back" }).click();
  // the list survives a reload (it lives in the user document), and Settings renames the tag in both drawers
  await page.reload();
  await openSettings(page);
  await page.getByTestId("settings-manage-tags").click();
  const mgr = page.getByTestId("tag-manager");
  await expect(mgr.getByTestId("tag-manager-row")).toHaveCount(2);
  await expect(mgr.getByTestId("tag-manager-summary")).toHaveText(["No items yet", "Kitchen: Jar · Office: Petty box"]);
  await expect(mgr.getByRole("button", { name: "groceries, 2 items" })).toBeVisible();
  await openTag(page, "groceries");
  await expect(page.getByTestId("tag-detail-drawer")).toHaveText(["KitchenJar", "OfficePetty box"]);
  await page.getByTestId("tag-detail-rename").click();
  await page.getByRole("dialog").getByRole("textbox", { name: "New name" }).fill("food");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { level: 2 })).toHaveText("food");
  await page.getByRole("dialog").getByRole("button", { name: "Back" }).click();
  await expect(mgr.getByTestId("tag-manager-row")).toHaveText([/^emergency/, /^food/]);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  // PETTY-154: the home search finds items by tag, in every drawer, and shows their tags
  await page.goto("/");
  await page.getByTestId("home-search-toggle").click();
  await page.getByLabel("Search drawers, places, items and tags").fill("FOO");
  await expect(page.getByTestId("search-count")).toHaveText("2 items in 2 drawers");
  await expect(page.getByTestId("search-hit")).toHaveCount(2);
  await expect(page.getByTestId("search-hit-tags").first()).toHaveText("food");
  await page.getByLabel("Search drawers, places, items and tags").fill("emerg");
  await expect(page.getByTestId("search-count")).toHaveText("Nothing matches."); // a tag on no item finds nothing
  await page.getByLabel("Search drawers, places, items and tags").press("Escape");
  for (const [drawer, item] of [["Kitchen", "Jar"], ["Office", "Petty box"]] as const) {
    await page.goto("/");
    await page.getByTestId("drawer-row").filter({ hasText: drawer }).click();
    await expect(page.getByTestId("line-row").filter({ hasText: item }).getByTestId("line-tags")).toHaveText("food");
  }
});

test("tags per person (PETTY-152): a read-only shared drawer keeps the old tag and the manager says so; the tag stays shared on the item", async ({ browser }) => {
  const alice = await signupWithKeys("tagro-a");
  const bob = await signupWithKeys("tagro-b");
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await loginAndUnlock(pageA, alice);
  const id = await addDrawer(pageA, "Safe");
  await addMoneyLine(pageA, "Gold", "PLN", "1");
  await pageA.getByRole("button", { name: "Open Gold" }).click(); await pageA.getByRole("button", { name: "Options for Gold" }).click(); await pageA.getByTestId("line-tags-btn").click();
  await pickTags(pageA, ["valuables"]);
  await shareViaApi(alice, id, bob, "read");
  await loginAndUnlock(pageB, bob);
  // Bob sees Alice's tag on the shared item, and in his own list
  await pageB.getByTestId("drawer-row").filter({ hasText: "Safe" }).click();
  await expect(pageB.getByTestId("line-row").filter({ hasText: "Gold" }).getByTestId("line-tags")).toHaveText("valuables");
  await openSettings(pageB);
  await pageB.getByTestId("settings-manage-tags").click();
  await openTag(pageB, "valuables");
  await expect(pageB.getByTestId("tag-detail-drawer")).toHaveText(["Safe · read-onlyGold"]);
  await pageB.getByTestId("tag-detail-rename").click();
  await pageB.getByRole("dialog").getByRole("textbox", { name: "New name" }).fill("gold");
  await pageB.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(pageB.getByText("1 shared drawer is read-only and keeps the old tag.")).toBeVisible();
  // the drawer tag reappears through the merge: Bob now has both names
  await expect(pageB.getByTestId("tag-detail-empty")).toBeVisible(); // Bob's "gold" is on no item he can change
  await pageB.getByRole("dialog").getByRole("button", { name: "Back" }).click();
  await expect(pageB.getByTestId("tag-manager-row")).toHaveText([/^gold/, /^valuables/]);
  await pageA.goto(`/drawers/${id}`);
  await expect(pageA.getByTestId("line-row").filter({ hasText: "Gold" }).getByTestId("line-tags")).toHaveText("valuables");
});
