import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * PETTY-248: the "One idea, many uses" demo on the landing page. Every example is the app's one
 * pattern — places in a tree, drawers in places, items in drawers — each in its own shape and with its
 * own picture, and each turns into the next; a last step puts them all together. Timers run on
 * Playwright's clock, so the 5.5 s steps take no real time.
 */
const STEP = 5600;
const FINALE = 8000;
const EXAMPLES = ["workshop", "trip", "accounts", "cash", "lent", "family"] as const;

async function openDemo(page: Page): Promise<Locator> {
  await page.clock.install();
  await page.goto("/");
  const stage = page.getByTestId("use-case-stage");
  await stage.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2); // keep the pointer off the demo: hovering holds it
  return stage;
}
/** Lets the lines' fades finish (their timers are on the fake clock) so only the current words are in the page. */
async function settle(page: Page, stage: Locator) {
  await page.clock.runFor(1200);
  await expect(stage.locator(".morph-out")).toHaveCount(0);
}
/** Takes focus and the mouse out of the demo (either holds the autoplay) without scrolling it away. */
async function leave(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(2, 2);
}

test("every example is place › drawer › items; it moves on by itself, Pause holds it, picking one stops it", async ({ page }) => {
  const stage = await openDemo(page);
  const toggle = page.getByTestId("use-case-toggle");
  await expect(stage).toHaveAttribute("data-case", "workshop");
  await expect(stage).toContainText("Basement");
  await expect(stage).toContainText("Workshop");
  await expect(page.getByTestId("use-case-drawer").first()).toHaveText("Desk drawer");
  await expect(stage).toContainText("Zip ties");
  await expect(stage).toContainText("50 pcs");
  await expect(page.getByTestId("use-case-workshop")).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveText("Pause");

  // it moves on by itself, one example every 5.5 s
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "trip");
  await settle(page, stage);
  await expect(page.getByTestId("use-case-drawer").first()).toHaveText("George Town kitty");
  await expect(stage).toContainText("600.00");
  await expect(stage).toContainText("MYR");
  await expect(page.getByTestId("use-case-trip")).toHaveAttribute("aria-pressed", "true");

  // Pause holds it; Play goes on
  await toggle.click();
  await expect(toggle).toHaveText("Play");
  await leave(page);
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-case", "trip");
  await toggle.click();
  await expect(toggle).toHaveText("Pause");
  await leave(page);
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "accounts");

  // every example is places, drawers and items, all with words in them — each in its own shape —
  // and every item wears the colour of its kind: money, things or notes
  const shapes = new Set<string>();
  for (const key of EXAMPLES) {
    await page.getByTestId(`use-case-${key}`).click();
    await expect(stage).toHaveAttribute("data-case", key);
    await settle(page, stage);
    const places = stage.locator(".uc-line.t-place");
    const drawers = stage.locator(".uc-line.t-drawer");
    const items = stage.locator(".uc-line.t-item");
    for (const l of [places, drawers, items]) expect(await l.count()).toBeGreaterThan(0);
    for (const l of [...(await places.all()), ...(await drawers.all()), ...(await items.all())]) await expect(l).not.toHaveText("");
    expect(await stage.locator(".uc-line.t-item .tile:is(.k-money, .k-things, .k-notes)").count()).toBe(await items.count());
    const depth = Math.max(...await places.evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).getPropertyValue("--lvl")))));
    shapes.add(`${await places.count()}/${depth}/${await drawers.count()}/${await items.count()}`);
    await expect(page.getByTestId(`use-case-${key}`)).toHaveAttribute("aria-pressed", "true");
  }
  expect(shapes.size, [...shapes].join(" ")).toBeGreaterThanOrEqual(5);
  // picking an example stopped the autoplay for good
  await expect(toggle).toHaveText("Play");
  await leave(page);
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-case", "family");
});

test("each example has its picture; after the six, a last step puts them all together, then it starts again", async ({ page }) => {
  const stage = await openDemo(page);
  const art = page.getByTestId("use-case-art");
  for (const key of EXAMPLES) {
    await expect(stage).toHaveAttribute("data-case", key);
    await expect(art).toHaveAttribute("data-scene", key); // the picture follows the example
    await page.clock.runFor(STEP);
  }
  // one drawer from each example, each saying where it is, and one picture of them all around the home
  await expect(stage).toHaveAttribute("data-case", "all");
  await expect(art).toHaveAttribute("data-scene", "all");
  await settle(page, stage);
  await expect(page.getByTestId("use-case-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("use-case-caption")).toContainText("All of it, in one place");
  await expect(page.getByTestId("use-case-drawer")).toHaveText(["Pegboard", "George Town kitty", "Pension", "Cash tin", "Lent out", "Documents"]);
  await expect(page.getByTestId("use-case-path")).toHaveText(["Basement › Workshop", "Malaysia", "Paperwork", "Kitchen", "Garage", "Bedroom › Wardrobe › Safe"]);
  await expect(art.locator(".uc-bub-label > :not(.morph-out)")).toHaveText(["Workshop", "Trip kitty", "Yearly accounts", "Cash at home", "Lent out", "Family safe"]);
  // it stays longer than an example, then starts again
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "all");
  await page.clock.runFor(FINALE - STEP + 100);
  await expect(stage).toHaveAttribute("data-case", "workshop");
  await expect(art).toHaveAttribute("data-scene", "workshop");
});

test("reduced motion: the demo never moves on its own, and a picked example shows at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stage = await openDemo(page);
  await expect(page.getByTestId("use-case-toggle")).toHaveText("Play");
  await page.clock.runFor(30_000);
  await expect(stage).toHaveAttribute("data-case", "workshop");
  await page.getByTestId("use-case-cash").click();
  await expect(stage.getByText("Cash tin")).toBeVisible();
  await expect(stage.getByText("Desk drawer")).toBeHidden(); // no fading copy of the old words
  await expect(page.getByTestId("use-case-art")).toHaveAttribute("data-scene", "cash");
  await expect(page.getByTestId("use-case-art")).not.toHaveClass(/unseen/); // the picture is there at once
});

test("the Polish page shows the same examples in Polish, with no local names or currency", async ({ page }) => {
  const stage = await openDemo(page);
  await page.getByRole("button", { name: "Polski" }).click();
  await expect(page.getByRole("heading", { name: "Jeden pomysł, wiele zastosowań" })).toBeVisible();
  await settle(page, stage);
  await expect(stage).toContainText("Piwnica");
  await expect(page.getByTestId("use-case-drawer").first()).toHaveText("Szuflada biurka");
  for (const key of [...EXAMPLES, "all"]) {
    await page.getByTestId(`use-case-${key}`).click();
    await settle(page, stage);
    await expect(stage).not.toContainText("PLN");
    await expect(stage).not.toContainText("zł");
  }
});

test("the demo passes axe (WCAG 2.1 AA)", async ({ page }) => {
  await openDemo(page);
  const r = await new AxeBuilder({ page }).include('[data-testid="use-cases"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});
