import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, loginAndUnlock, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-250: the app's pictures, in the landing page's look. A drawer's screen shows the drawer with
 * its lines around it in their kinds' colours; the Home total sits beside the home with its drawers, or,
 * once there are places, above the place tree (PETTY-257, e2e/home-places.spec.ts).
 * Every bubble is a shortcut that opens what it shows (its bubble grows into the next picture through
 * a view transition) — a mouse or touch shortcut for the list below it, which stays the keyboard path.
 */
async function addDrawer(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;
}
async function addLine(page: Page, kind: "Money" | "Countable" | "Single item", name: string, fill: Record<string, string>) {
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByRole("group").getByRole("button", { name: kind }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  for (const [label, value] of Object.entries(fill)) await page.getByLabel(label, { exact: label === "Currency" }).fill(value);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("line-name").filter({ hasText: name })).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden(); // the sheet closes once the starting amount is saved too
}
/** A picture's bubble, found by the name it shows on hover. */
const bubble = (page: Page, picture: string, name: string) => page.getByTestId(picture).locator(".uc-bub-hit").filter({ hasText: name });
/** Counts calls to the View Transitions API, so a test can tell the morph ran. */
async function countMorphs(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { morphs: number };
    w.morphs = 0;
    const doc = document as Document & { startViewTransition: (cb: () => unknown) => unknown };
    const original = doc.startViewTransition.bind(doc);
    doc.startViewTransition = (cb) => { w.morphs++; return original(cb); };
  });
}
const morphs = (page: Page) => page.evaluate(() => (window as unknown as { morphs: number }).morphs);

test("the pictures show each drawer's lines in their kinds' colours, and every bubble opens what it shows", async ({ page }) => {
  const user = await signupWithKeys("pia");
  await loginAndUnlock(page, user);
  const kitchen = await addDrawer(page, "Kitchen");
  await addLine(page, "Money", "Groceries", { Currency: "EUR", "Starting balance": "100" });
  await addLine(page, "Single item", "Passport", { Text: "expires 2031" });
  // a line's tile, and its bubble in the drawer's picture, wear its kind's colour
  await expect(page.getByTestId("line-row").filter({ hasText: "Groceries" }).locator(".tile")).toHaveClass(/k-money/);
  await expect(page.getByTestId("line-row").filter({ hasText: "Passport" }).locator(".tile")).toHaveClass(/k-notes/);
  await expect(page.getByTestId("drawer-art")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("drawer-art").locator(".uc-bub.sat")).toHaveCount(2);
  // PETTY-269: each line's name sits by its bubble
  await expect(page.getByTestId("drawer-art").locator(".uc-bub-name")).toHaveText(["Groceries", "Passport"]);
  // the place: Kitchen sits in Home
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-tags").click();
  await page.getByTestId("drawer-place-picker").getByTestId("place-new").fill("Home");
  await page.getByTestId("drawer-place-picker").getByRole("button", { name: "Add place" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  // in-app navigation: the place is still being saved, and a full reload would cut that off
  await page.getByRole("button", { name: "Back" }).click();
  const garage = await addDrawer(page, "Garage");
  await addLine(page, "Countable", "Screws", { "Unit (optional)": "boxes", "Starting count": "6" });
  await expect(page.getByTestId("drawer-art").locator(".uc-bub.sat.k-things")).toHaveCount(1);

  // Home: the total above the place tree with both drawers; each card has one dot per line in its colour
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("places-art")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).locator(".kd")).toHaveCount(2);
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).locator(".kd.k-money")).toHaveCount(1);
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).getByTestId("row-place")).toHaveText("Home");

  // picking a place narrows the picture to it; the place in its middle goes back to every drawer
  await page.getByTestId("tag-bar").getByRole("button", { name: /^Home/ }).click();
  await expect(page.getByTestId("places-art")).toHaveAttribute("data-count", "1");
  await page.getByTestId("places-art").locator(".pa-bub.center .uc-bub-hit").click();
  await expect(page.getByTestId("places-art")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("tag-bar").getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");

  // a drawer's bubble opens the drawer, growing into its picture
  await countMorphs(page);
  await bubble(page, "places-art", "Garage").click();
  await expect(page).toHaveURL(new RegExp(`/drawers/${garage}$`));
  await expect(page.getByRole("heading", { name: "Garage" })).toBeVisible();
  expect(await morphs(page)).toBe(1);
  // a line's bubble opens the line
  await bubble(page, "drawer-art", "Screws").click();
  await expect(page.getByRole("heading", { name: "Screws" })).toBeVisible();
  await expect(page.getByTestId("line-balance")).toHaveText("6");
  // PETTY-269: Back plays the other way — the line's bubble shrinks into its place in the drawer's picture
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Garage" })).toBeVisible();
  expect(await morphs(page)).toBe(3);
  // the drawer in the middle opens its options
  await page.goto(`/drawers/${kitchen}`);
  await page.getByTestId("drawer-art").locator(".uc-bub.center .uc-bub-hit").click();
  await expect(page.getByRole("dialog", { name: "Drawer options" })).toBeVisible();
  await page.keyboard.press("Escape");

  // the shortcuts repeat the list, so they stay out of the tab order and the accessibility tree
  // (axe measures colours, so nothing may be mid-fade: reduced motion shows every screen at rest)
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const path of ["/", `/drawers/${kitchen}`]) {
    await page.goto(path);
    const picture = page.getByTestId(path === "/" ? "places-art" : "drawer-art");
    await expect(picture).toBeVisible();
    await expect(picture.getByRole("button")).toHaveCount(0);
    for (const hit of await picture.locator(".uc-bub-hit").all()) await expect(hit).toHaveAttribute("tabindex", "-1");
    const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious, `${path}: ${JSON.stringify(serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))}`).toEqual([]);
  }
});

test("reduced motion: the pictures still open what they show, without a morph", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const user = await signupWithKeys("rex");
  await loginAndUnlock(page, user);
  const id = await addDrawer(page, "Shed");
  await page.goto("/");
  await countMorphs(page);
  await bubble(page, "home-art", "Shed").click();
  await expect(page).toHaveURL(new RegExp(`/drawers/${id}$`));
  expect(await morphs(page)).toBe(0);
});

test("more than six: five and a +N; pointing at it (or tapping it) brings those out and folds the far side into a new +N", async ({ page }) => {
  const user = await signupWithKeys("ivy");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Attic");
  for (let i = 1; i <= 7; i++) await addLine(page, "Single item", `Box ${i}`, { Text: `shelf ${i}` });
  const art = page.getByTestId("drawer-art");
  await expect(art).toHaveAttribute("data-count", "7");
  const shown = () => art.locator(".uc-bub.sat:not(.off):not(.uc-more-bub):not(.uc-more-burst) .uc-bub-tip").allTextContents();
  const more = art.locator(".uc-more-bub");
  await expect.poll(shown).toEqual(["Box 1", "Box 2", "Box 3", "Box 4", "Box 5"]);
  await expect(more).toHaveText("+2");
  // a mouse pointing at it: the two come out, and the two across the ring fold into a new +2
  await more.locator(".uc-bub-hit").hover();
  await expect.poll(shown).toEqual(["Box 1", "Box 2", "Box 5", "Box 6", "Box 7"]);
  await expect(more).toHaveText("+2");
  await expect(art.locator(".uc-bub.sat.off")).toHaveCount(2);
  // a tap (no hover on a touch screen) does the same
  await page.mouse.move(2, 2);
  await more.locator(".uc-bub-hit").dispatchEvent("click");
  await expect.poll(shown).toEqual(["Box 2", "Box 3", "Box 4", "Box 5", "Box 6"]);
  // the bubbles still open their lines
  await page.waitForTimeout(500);
  await bubble(page, "drawer-art", "Box 4").click();
  await expect(page.getByRole("heading", { name: "Box 4" })).toBeVisible();
});
