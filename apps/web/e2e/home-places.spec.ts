import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, loginAndUnlock, openSettings, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-257: with places, the Home picture is the place tree. The places stand on the first ring round the
 * home, what is in each place round it; a place's bubble picks the place (as its chip does) and the picture
 * goes one level down; the middle and the corner bubbles go back up. Settings can switch the picture off.
 * The drawers are made through the app's own store (dev build), each with its place.
 */
async function makeDrawers(page: Page, list: [string, string[]][]) {
  const made = await page.evaluate(async (list) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/src\/lib\/drawers\.ts(\?|$)/.test(n)).at(-1);
    if (!url) return 0;
    const m = (await import(url)) as { createDrawer: (name: string, tags: readonly string[]) => Promise<string> };
    for (const [name, place] of list) await m.createDrawer(name, place);
    return list.length;
  }, list);
  expect(made, "the drawers must be made in the app's own store").toBe(list.length);
}
const art = (page: Page) => page.getByTestId("places-art");
/** The names on the bubbles in view of one kind, in the order they are drawn. */
const shown = (page: Page, kind: string) => art(page).locator(`.pa-bub.${kind}:not(.off) .uc-bub-tip`).allTextContents();
const tap = (page: Page, kind: string, name: string) => art(page).locator(`.pa-bub.${kind}:not(.off) .uc-bub-hit`).filter({ hasText: name }).click();
const shots = process.env["SHOTS"]; // a folder: the test leaves a capture of each step there, for a look by eye

test("with places, the picture is the place tree: a place's bubble picks it and goes one level down, the middle goes back up", async ({ page }) => {
  const user = await signupWithKeys("tre");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await makeDrawers(page, [
    ["Cash tin", ["Flat", "Kitchen"]], ["Coin jar", ["Flat", "Kitchen"]], ["Shoe box", ["Flat", "Bedroom"]],
    ["Safe", ["Flat"]], ["Tool box", ["Garage"]], ["Wallet", []],
  ]);
  // the first ring: the places, and the drawer with no place; round each place, what is in it
  await expect(art(page)).toHaveAttribute("data-count", "6");
  await expect(art(page)).toHaveAttribute("data-view", "");
  await expect.poll(() => shown(page, "place")).toEqual(["Flat", "Garage"]);
  await expect.poll(() => shown(page, "drawer")).toEqual(["Wallet"]);
  await expect.poll(() => shown(page, "sub")).toEqual(["Kitchen", "Bedroom"]);
  await expect.poll(() => shown(page, "sat")).toEqual(["Safe", "Tool box"]);
  await expect(art(page).locator(".pa-bub.place .pa-label")).toHaveText(["Flat", "Garage"]);
  if (shots) await page.screenshot({ path: `${shots}/home-places-1-all.png` });

  // a place's bubble picks it, as its chip does: it moves to the middle, the home waits in the corner
  await tap(page, "place", "Flat");
  await expect(art(page)).toHaveAttribute("data-view", "flat");
  await expect(art(page)).toHaveAttribute("data-count", "4");
  await expect(page.getByTestId("tag-bar").getByRole("button", { name: /^Flat/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("drawers-header")).toContainText("4 drawers");
  await expect(art(page).locator(".pa-bub.center .pa-label")).toHaveText("Flat");
  await expect(art(page).locator(".pa-bub.crumb")).toHaveCount(1);
  await expect.poll(() => shown(page, "place")).toEqual(["Kitchen", "Bedroom"]);
  await expect.poll(() => shown(page, "drawer")).toEqual(["Safe"]);
  await expect.poll(() => shown(page, "sat")).toEqual(["Cash tin", "Coin jar", "Shoe box"]);
  await page.waitForTimeout(900); // the glide
  if (shots) await page.screenshot({ path: `${shots}/home-places-2-flat.png` });

  // the same one level further down; the middle goes back up one level, a corner bubble to its level
  await tap(page, "place", "Kitchen");
  await expect(art(page)).toHaveAttribute("data-view", "flat/kitchen");
  await expect(art(page).locator(".pa-bub.crumb")).toHaveCount(2);
  await expect.poll(() => shown(page, "drawer")).toEqual(["Cash tin", "Coin jar"]);
  await page.waitForTimeout(900);
  if (shots) await page.screenshot({ path: `${shots}/home-places-3-kitchen.png` });
  await art(page).locator(".pa-bub.center .uc-bub-hit").click();
  await expect(art(page)).toHaveAttribute("data-view", "flat");
  await tap(page, "crumb", "Back to all drawers");
  await expect(art(page)).toHaveAttribute("data-view", "");
  await expect(page.getByTestId("tag-bar").getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");

  // a small bubble picks its place two levels down at once
  await tap(page, "sub", "Bedroom");
  await expect(art(page)).toHaveAttribute("data-view", "flat/bedroom");
  await expect.poll(() => shown(page, "drawer")).toEqual(["Shoe box"]);
  await page.getByTestId("tag-bar").getByRole("button", { name: /^All/ }).click();
  await expect(art(page)).toHaveAttribute("data-view", "");

  // the shortcuts stay out of the tab order and the accessibility tree (at rest: axe measures colours, so
  // the page is drawn again under reduced motion, with nothing mid-fade)
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(art(page)).toHaveAttribute("data-count", "6");
  await expect(art(page).getByRole("button")).toHaveCount(0);
  for (const hit of await art(page).locator(".uc-bub-hit").all()) await expect(hit).toHaveAttribute("tabindex", "-1");
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => v.id)).toEqual([]);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // a drawer's bubble opens the drawer
  await tap(page, "drawer", "Wallet");
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  // Settings can switch the picture off, and on again (in-app: a reload would cut off the setting's save)
  await openSettings(page);
  await expect(page.getByTestId("picture-switch")).toBeChecked();
  await page.getByTestId("picture-switch").click();
  await expect(page.getByTestId("picture-switch")).not.toBeChecked();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("drawer-row").first()).toBeVisible();
  await expect(art(page)).toHaveCount(0);
  await expect(page.getByTestId("home-art")).toHaveCount(0);
  await openSettings(page);
  await page.getByTestId("picture-switch").click();
  await expect(page.getByTestId("picture-switch")).toBeChecked();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(art(page)).toBeVisible();
});

test("more than six on the first ring: five and a +N that turns the ring; a place's +N picks the place", async ({ page }) => {
  const user = await signupWithKeys("mny");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await makeDrawers(page, [
    ...["A", "B", "C", "D", "E", "F"].map((n): [string, string[]] => [`Box ${n}`, []]),
    ...["1", "2", "3", "4", "5"].map((n): [string, string[]] => [`Shelf ${n}`, ["Attic"]]),
  ]);
  await expect(art(page)).toHaveAttribute("data-count", "11");
  // seven on the first ring (the Attic and six boxes): five, and a +2
  await expect(art(page).locator(".pa-bub.more .pa-more")).toHaveText("+2");
  await expect.poll(async () => (await shown(page, "place")).length + (await shown(page, "drawer")).length).toBe(5);
  const before = [...(await shown(page, "place")), ...(await shown(page, "drawer"))];
  await art(page).locator(".pa-bub.more .uc-bub-hit").click();
  await expect.poll(async () => [...(await shown(page, "place")), ...(await shown(page, "drawer"))].join()).not.toBe(before.join());
  // five shelves in the Attic: with the first ring full, three show round it and a +3
  await expect(art(page).locator(".pa-bub.more2 .pa-more")).toHaveText("+3");
  await art(page).locator(".pa-bub.more2 .uc-bub-hit").click();
  await expect(art(page)).toHaveAttribute("data-view", "attic");
  await expect.poll(() => shown(page, "drawer")).toEqual(["Shelf 1", "Shelf 2", "Shelf 3", "Shelf 4", "Shelf 5"]);
  if (shots) { await page.waitForTimeout(900); await page.screenshot({ path: `${shots}/home-places-4-attic.png` }); }
});

test("a level with only one place in it shows what is in that place, and the place's name labels the middle", async ({ page }) => {
  const user = await signupWithKeys("hse");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await makeDrawers(page, [["Cash tin", ["House", "Kitchen"]], ["Shoe box", ["House", "Bedroom"]], ["Tool box", ["House", "Basement"]]]);
  await expect(art(page)).toHaveAttribute("data-count", "3");
  // not one "House" bubble on an empty ring: its rooms, round the home that is labelled House
  await expect.poll(() => shown(page, "place")).toEqual(["Kitchen", "Bedroom", "Basement"]);
  await expect(art(page).locator(".pa-bub.center .pa-label")).toHaveText("House");
  await tap(page, "place", "Kitchen");
  await expect(art(page)).toHaveAttribute("data-view", "house/kitchen");
  await expect(art(page).locator(".pa-bub.crumb")).toHaveCount(2);
  await expect.poll(() => shown(page, "drawer")).toEqual(["Cash tin"]);
});

test("the way back (PETTY-269): Back from a drawer lands on the place it was opened from, and its trail opens any level above", async ({ page }) => {
  const user = await signupWithKeys("bck");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await makeDrawers(page, [["Cash tin", ["Flat", "Kitchen"]], ["Coin jar with a very long name for its label", ["Flat", "Kitchen"]], ["Shoe box", ["Flat", "Bedroom"]], ["Wallet", []]]);
  await tap(page, "place", "Flat");
  await tap(page, "place", "Kitchen");
  await expect(art(page)).toHaveAttribute("data-view", "flat/kitchen");
  // the drawers on the first ring carry their names; a long one is cut short
  await expect(art(page).locator(".pa-bub.drawer:not(.off) .pa-label")).toHaveText(["Cash tin", "Coin jar with a very long name for its label"]);
  const cut = art(page).locator(".pa-bub.drawer:not(.off) .pa-label").nth(1);
  expect(await cut.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === "ellipsis")).toBe(true);
  // only transforms and opacity animate: nothing is laid out again frame by frame
  expect(await art(page).locator(".pa-bub").first().evaluate((e) => getComputedStyle(e).transitionProperty)).toBe("transform, opacity");

  // the drawer, and Back: the same level, not All
  await tap(page, "drawer", "Cash tin");
  await expect(page.getByRole("heading", { name: "Cash tin" })).toBeVisible();
  const trail = page.getByTestId("place-trail");
  await expect(trail.getByRole("button")).toHaveText(["All", "Flat", "Kitchen"]);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(art(page)).toHaveAttribute("data-view", "flat/kitchen");
  await expect(page.getByTestId("tag-bar").getByRole("button", { name: /^Kitchen/ })).toHaveAttribute("aria-pressed", "true");

  // the trail: one level up, or all the way to All
  await tap(page, "drawer", "Cash tin");
  await trail.getByRole("button", { name: "Flat", exact: true }).click();
  await expect(art(page)).toHaveAttribute("data-view", "flat");
  await tap(page, "place", "Kitchen");
  await tap(page, "drawer", "Cash tin");
  await trail.getByRole("button", { name: "All", exact: true }).click();
  await expect(art(page)).toHaveAttribute("data-view", "");

  // a drawer with no place has no trail
  await tap(page, "drawer", "Wallet");
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible();
  await expect(page.getByTestId("place-trail")).toHaveCount(0);
});
