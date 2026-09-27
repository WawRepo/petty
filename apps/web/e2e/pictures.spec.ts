import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, loginAndUnlock, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-250: the app's pictures, in the landing page's look. A drawer's screen shows the drawer with
 * its lines around it in their kinds' colours; the Home total sits beside the home with its drawers.
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
  // the place: Kitchen sits in Home
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-tags").click();
  await page.getByTestId("drawer-place-picker").getByTestId("place-new").fill("Home");
  await page.getByTestId("drawer-place-picker").getByRole("button", { name: "Add place" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.goto("/");
  const garage = await addDrawer(page, "Garage");
  await addLine(page, "Countable", "Screws", { "Unit (optional)": "boxes", "Starting count": "6" });
  await expect(page.getByTestId("drawer-art").locator(".uc-bub.sat.k-things")).toHaveCount(1);

  // Home: the total beside the home with both drawers; each card has one dot per line in its colour
  await page.goto("/");
  await expect(page.getByTestId("home-art")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).locator(".kd")).toHaveCount(2);
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).locator(".kd.k-money")).toHaveCount(1);
  await expect(page.getByTestId("drawer-row").filter({ hasText: "Kitchen" }).getByTestId("row-place")).toHaveText("Home");

  // picking a place narrows the picture; the home in its middle goes back to every drawer
  await page.getByTestId("tag-bar").getByRole("button", { name: /^Home/ }).click();
  await expect(page.getByTestId("home-art")).toHaveAttribute("data-count", "1");
  await page.getByTestId("home-art").locator(".uc-bub.center .uc-bub-hit").click();
  await expect(page.getByTestId("home-art")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("tag-bar").getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");

  // a drawer's bubble opens the drawer, growing into its picture
  await countMorphs(page);
  await bubble(page, "home-art", "Garage").click();
  await expect(page).toHaveURL(new RegExp(`/drawers/${garage}$`));
  await expect(page.getByRole("heading", { name: "Garage" })).toBeVisible();
  expect(await morphs(page)).toBe(1);
  // a line's bubble opens the line
  await bubble(page, "drawer-art", "Screws").click();
  await expect(page.getByRole("heading", { name: "Screws" })).toBeVisible();
  await expect(page.getByTestId("line-balance")).toHaveText("6");
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
    const picture = page.getByTestId(path === "/" ? "home-art" : "drawer-art");
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

test("more than six lines: the picture shows five and a +N that goes down to the full list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 560 });
  const user = await signupWithKeys("ivy");
  await loginAndUnlock(page, user);
  await addDrawer(page, "Attic");
  for (let i = 1; i <= 7; i++) await addLine(page, "Single item", `Box ${i}`, { Text: `shelf ${i}` });
  await expect(page.getByTestId("drawer-art")).toHaveAttribute("data-count", "7");
  await expect(page.getByTestId("drawer-art").locator(".uc-bub.sat")).toHaveCount(6);
  await page.evaluate(() => window.scrollTo(0, 0));
  await bubble(page, "drawer-art", "All items").click();
  await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('[data-testid="lines"]')!.getBoundingClientRect().top))).toBeLessThan(80);
});
