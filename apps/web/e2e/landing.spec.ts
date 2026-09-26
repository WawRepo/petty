import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * PETTY-248: the "One idea, many uses" demo on the landing page. Every example is the app's one
 * pattern — three places, a drawer in the last, four items in the drawer — and each turns into the
 * next. Timers run on Playwright's clock, so the 5 s steps take no real time.
 */
const EXAMPLES = ["workshop", "trip", "accounts", "cash", "lent", "family"] as const;

async function openDemo(page: Page): Promise<Locator> {
  await page.clock.install();
  await page.goto("/");
  const stage = page.getByTestId("use-case-stage");
  await stage.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2); // keep the pointer off the demo: hovering holds it
  return stage;
}
/** Lets the slot rolls finish (their timers are on the fake clock) so only the current words are in the page. */
async function settle(page: Page, stage: Locator) {
  await page.clock.runFor(1200);
  await expect(stage.locator(".morph-out")).toHaveCount(0);
}
/** Clicks outside the demo: focus inside it holds the autoplay too. */
async function leave(page: Page) {
  await page.locator(".landing-hero").click({ position: { x: 4, y: 4 } });
  await page.mouse.move(2, 2);
}

test("every example is place › drawer › items; it moves on by itself, Pause holds it, picking one stops it", async ({ page }) => {
  const stage = await openDemo(page);
  const toggle = page.getByTestId("use-case-toggle");
  await expect(stage).toHaveAttribute("data-case", "workshop");
  await expect(stage).toContainText("Basement");
  await expect(stage).toContainText("Desk, right");
  await expect(page.getByTestId("use-case-drawer")).toHaveText("Drawer 1");
  await expect(stage).toContainText("Zip ties");
  await expect(stage).toContainText("50 pcs");
  await expect(page.getByTestId("use-case-workshop")).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveText("Pause");

  // it moves on by itself, one example every 5 s
  await page.clock.runFor(5100);
  await expect(stage).toHaveAttribute("data-case", "trip");
  await settle(page, stage);
  await expect(page.getByTestId("use-case-drawer")).toHaveText("George Town, May");
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
  await page.clock.runFor(5100);
  await expect(stage).toHaveAttribute("data-case", "accounts");

  // every example has the same shape: three places, a drawer, four items, all with words in them
  for (const key of EXAMPLES) {
    await page.getByTestId(`use-case-${key}`).click();
    await expect(stage).toHaveAttribute("data-case", key);
    await settle(page, stage);
    await expect(stage.locator(".uc-node")).toHaveCount(3);
    for (const node of await stage.locator(".uc-node").all()) await expect(node).not.toHaveText("");
    await expect(page.getByTestId("use-case-drawer")).not.toHaveText("");
    await expect(stage.locator(".uc-item")).toHaveCount(4);
    for (const item of await stage.locator(".uc-item .uc-item-name").all()) await expect(item).not.toHaveText("");
    await expect(page.getByTestId(`use-case-${key}`)).toHaveAttribute("aria-pressed", "true");
  }
  // picking an example stopped the autoplay for good
  await expect(toggle).toHaveText("Play");
  await leave(page);
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-case", "family");
});

test("reduced motion: the demo never moves on its own, and a picked example shows at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stage = await openDemo(page);
  await expect(page.getByTestId("use-case-toggle")).toHaveText("Play");
  await page.clock.runFor(30_000);
  await expect(stage).toHaveAttribute("data-case", "workshop");
  await page.getByTestId("use-case-cash").click();
  await expect(stage.getByText("Cash tin")).toBeVisible();
  await expect(stage.getByText("Drawer 1")).toBeHidden(); // no rolling copy of the old words
});

test("the Polish page shows the same examples in Polish, with no local names or currency", async ({ page }) => {
  const stage = await openDemo(page);
  await page.getByRole("button", { name: "Polski" }).click();
  await expect(page.getByRole("heading", { name: "Jeden pomysł, wiele zastosowań" })).toBeVisible();
  await settle(page, stage);
  await expect(stage).toContainText("Piwnica");
  await expect(page.getByTestId("use-case-drawer")).toHaveText("Szuflada 1");
  for (const key of EXAMPLES) {
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
