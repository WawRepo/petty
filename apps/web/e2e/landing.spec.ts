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

test("every example is place › drawer › items; it plays by itself, Pause and keyboard focus hold it, a pick jumps there and plays on", async ({ page }) => {
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

  // keyboard focus in the demo holds it too
  await page.getByTestId("use-case-trip").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("use-case-trip")).toBeFocused();
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-case", "accounts");
  await leave(page);
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "cash");

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
  // a pick jumped there and it plays on from it: the focus a mouse click leaves does not hold it
  await expect(toggle).toHaveText("Pause");
  await expect(page.getByTestId("use-case-family")).toBeFocused();
  await page.mouse.move(2, 2);
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "all");
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
  // it stays longer than an example, then starts again. Timed from a fresh start of the step (a mouse
  // over the demo holds it, leaving starts it again): the fake clock also runs in real time, so a busy
  // machine must not eat into the margins.
  await page.getByTestId("use-case-all").hover();
  await page.mouse.move(2, 2);
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "all");
  await page.clock.runFor(FINALE - STEP + 100);
  await expect(stage).toHaveAttribute("data-case", "workshop");
  await expect(art).toHaveAttribute("data-scene", "workshop");
});

test("it plays as soon as a little of it is in view, and only a mouse over the phone or the icon row holds it (PETTY-251)", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const stage = page.getByTestId("use-case-stage");
  await stage.waitFor();
  // a quarter of the phone at the bottom of the window, as on a laptop's first screen
  await page.evaluate(() => {
    const r = document.querySelector('[data-testid="use-case-stage"]')!.getBoundingClientRect();
    window.scrollBy(0, r.top - window.innerHeight + r.height * 0.25);
  });
  await page.mouse.move(2, 2);
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "trip");
  // a mouse resting over the picture does not hold it
  await stage.scrollIntoViewIfNeeded();
  const art = (await page.getByTestId("use-case-art").boundingBox())!;
  await page.mouse.move(art.x + art.width / 2, art.y + 12);
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "accounts");
  // over the phone it does
  const phone = (await stage.boundingBox())!;
  await page.mouse.move(phone.x + phone.width / 2, phone.y + phone.height / 2);
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-case", "accounts");
});

test("reduced motion: the demo still plays, with fades only — nothing slides, pops or floats (PETTY-251)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stage = await openDemo(page);
  await expect(page.getByTestId("use-case-toggle")).toHaveText("Pause");
  await expect(page.getByTestId("use-case-art")).not.toHaveClass(/unseen/); // the picture is there at once
  await page.clock.runFor(STEP);
  await expect(stage).toHaveAttribute("data-case", "trip");
  await expect(page.getByTestId("use-case-art")).toHaveAttribute("data-scene", "trip");
  const motion = await page.evaluate(() => ({
    bubble: getComputedStyle(document.querySelector(".uc-bub")!).transitionDuration,
    line: getComputedStyle(document.querySelector(".uc-line")!).transitionDuration,
    float: getComputedStyle(document.querySelector(".uc-bub-float")!).animationName,
    words: getComputedStyle(document.querySelector(".uc-line-body > :last-child")!).animationName,
  }));
  expect(motion.bubble.split(",").every((d) => d.trim() === "0s")).toBe(true);
  expect(motion.line.split(",").every((d) => d.trim() === "0s")).toBe(true);
  expect(motion.float).toBe("none");
  expect(["uc-fade-still", "none"]).toContain(motion.words); // a fade (or, once settled, nothing)
  // a picked example shows; the old words fade out and are gone
  await page.getByTestId("use-case-cash").click();
  await expect(stage.getByText("Cash tin")).toBeVisible();
  await settle(page, stage);
  await expect(stage.getByText("George Town kitty")).toBeHidden();
  await expect(page.getByTestId("use-case-art")).toHaveAttribute("data-scene", "cash");
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

// PETTY-316: working with AI apps was a footer link 3,300 px down; now it is a section of its own, after
// "One idea, many uses" (PETTY-319): the example chat first, for any app, then the setup per app.
test("the AI section follows the use cases: MCP named, the chat names no app, the app buttons below it switch the real setup line, the add-on and /ai one click away", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const show = page.getByTestId("ai-show");
  await show.waitFor();
  const order = await page.evaluate(() => [...document.querySelectorAll("main.landing > *")].map((e) => (e as HTMLElement).dataset["testid"] ?? e.className));
  expect(order.indexOf("use-cases"), order.join(" | ")).toBe(order.indexOf("landing-hero") + 1);
  expect(order.indexOf("ai-show"), order.join(" | ")).toBe(order.indexOf("use-cases") + 1);
  // on a laptop's first screen the hero's link leads there
  const jump = page.getByTestId("landing-ai-jump");
  await expect(jump).toBeInViewport();
  await jump.click();
  await expect(page.getByText("Works with your AI app")).toBeInViewport();
  await expect(show).toContainText("Petty speaks MCP, the open standard AI apps use to plug in tools.");
  // the chat comes before the setup, and names no app whichever is picked
  const chatAbove = await page.evaluate(() => {
    const chat = document.querySelector(".ai-chat")!.getBoundingClientRect().top;
    return chat < document.querySelector('[data-testid="ai-app-desktop"]')!.getBoundingClientRect().top;
  });
  expect(chatAbove).toBe(true);
  await expect(page.getByTestId("ai-chat-app")).toHaveText("Your AI app");
  await expect(page.getByRole("heading", { name: "Set it up in your app" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Set it up in your app" }).getByRole("button")).toHaveCount(6);

  // Claude Desktop first: the add-on, no command
  await expect(page.getByTestId("ai-app-desktop")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ai-mcpb")).toHaveAttribute("href", "/downloads/petty.mcpb");
  await expect(page.getByTestId("ai-command")).toHaveCount(0);
  // each app its own line; one button pressed at a time
  await page.getByTestId("ai-app-code").click();
  await expect(page.getByTestId("ai-app-code")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ai-app-desktop")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("ai-chat-app")).toHaveText("Your AI app");
  await expect(page.getByTestId("ai-setup-app")).toHaveText("Claude Code");
  await expect(page.getByTestId("ai-command")).toHaveText("claude mcp add petty -- petty mcp");
  await expect(page.getByTestId("ai-mcpb")).toHaveCount(0);
  const origin = new URL(page.url()).origin;
  for (const [key, name] of [["cursor", "Cursor"], ["vscode", "VS Code"], ["windsurf", "Windsurf"]] as const) {
    await page.getByTestId(`ai-app-${key}`).click();
    await expect(page.getByTestId("ai-setup")).toContainText(`into ${name}:`);
    await expect(page.getByTestId("ai-command")).toHaveText(`node ~/.petty/petty-mcp.mjs --print-config ${origin}/api`);
  }
  await page.getByTestId("ai-app-any").press("Enter"); // a keyboard press works like a click
  await expect(page.getByTestId("ai-app-any")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ai-command")).toHaveText("io.github.WawRepo/petty");
  await expect(page.locator('.ai-app[aria-pressed="true"]')).toHaveCount(1);

  // the example amounts are EUR in the visitor's language
  await expect(show).toContainText("120.50 EUR");
  await expect(show).toContainText("100.50 EUR");
  // and the FAQ answers the question a careful visitor asks
  await page.getByText("Can an AI app read my drawers?").click();
  await expect(page.getByText(/What you ask about reaches the AI app you chose/)).toBeVisible();

  // the button opens the full guide
  await page.getByTestId("ai-show-more").click();
  await expect(page).toHaveURL(/\/ai$/);
});

test("on a phone the hero links to the AI section, and the section speaks the visitor's language (PETTY-316)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const jump = page.getByTestId("landing-ai-jump");
  await expect(jump).toBeInViewport();
  await jump.click();
  await expect(page.getByTestId("ai-show").getByRole("heading", { name: "Ask about your drawers in plain words" })).toBeInViewport();
  // nothing wider than the phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Polski" }).click();
  const show = page.getByTestId("ai-show");
  await expect(show.getByRole("heading", { name: "Pytaj o swoje szuflady zwykłymi słowami" })).toBeVisible();
  await expect(show).toContainText("120,50 EUR");
  await expect(page.getByTestId("ai-app-any")).toHaveText("Każda aplikacja MCP");
});

test("the AI section passes axe (WCAG 2.1 AA), light and dark", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await page.getByTestId("ai-show").waitFor();
    const r = await new AxeBuilder({ page }).include('[data-testid="ai-show"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});

test("the hero stands in the middle of wide screens too (PETTY-260)", async ({ page }) => {
  for (const width of [1100, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const hero = await page.locator(".landing-hero").boundingBox();
    const middle = await page.evaluate(() => document.documentElement.clientWidth / 2);
    expect(Math.abs(hero!.x + hero!.width / 2 - middle), `${width} px`).toBeLessThan(2);
  }
});

// PETTY-293 (review S8): every self-hosted copy shows this page. "Write to us" only when the operator names
// an address (CONTACT_EMAIL); no hosted-service promise; the cost answer claims no duty the AGPL does not create.
test("the hero says how to get in with and without a contact address, and makes no hosted-service promise", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("landing-access")).toHaveText("This Petty is invite-only: ask a member, or write to us.");

  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), contact_email: null } });
  });
  await page.reload();
  await expect(page.getByTestId("landing-access")).toHaveText("This Petty is invite-only: ask a member for an invite.");
  await expect(page.getByTestId("landing-invite")).toHaveCount(0);
  await expect(page.getByText("write to us")).toHaveCount(0);

  await page.getByText("What does it cost?").click();
  await expect(page.getByText(/the person who runs it sets the price/)).toBeVisible();
  await expect(page.getByText(/must tell you/)).toHaveCount(0);
});
