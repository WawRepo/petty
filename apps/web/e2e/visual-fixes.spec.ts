import type { Locator, Page } from "@playwright/test";
import { expect, loginAndUnlock, makeDrawers, openSettings, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-280: the look-and-feel findings of the UI review (PETTY-278) that a browser can measure —
 * contrast ratios, what overlaps, where a tap lands, which heading a page has. The rest (motion, hover
 * looks) were checked by eye on captures; the ticket says which.
 */
type Rgb = [number, number, number];
/** A computed colour: rgb(…) for plain colours, color(srgb …) in 0–1 for a color-mix(). */
const rgb = (css: string): Rgb => {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const c = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(css);
  if (c) return [Number(c[1]) * 255, Number(c[2]) * 255, Number(c[3]) * 255];
  throw new Error(`not a colour: ${css}`);
};
const lum = ([r, g, b]: Rgb) => {
  const c = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
/** The WCAG contrast ratio of two colours. */
const ratio = (a: Rgb, b: Rgb) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
const style = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
const pageBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: an off switch, a field's border, a danger button's text and a link meet their contrast (S2, F8, S3, S10)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    // F8: a field's border against the page, 3:1 (WCAG 1.4.11)
    await page.goto("/login");
    const field = page.getByLabel("Email");
    expect(ratio(rgb(await style(field, "border-top-color")), rgb(await pageBg(page)))).toBeGreaterThanOrEqual(3);
    // S10: a link in the app's colour, not the browser's blue
    await page.goto("/privacy");
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    const probe = await page.evaluate((c) => { const s = document.createElement("span"); s.style.color = c; document.body.append(s); const v = getComputedStyle(s).color; s.remove(); return v; }, accent);
    expect(await style(page.getByTestId("privacy-source"), "color")).toBe(probe);

    const user = await signupWithKeys(`vis${theme[0]}`);
    await loginAndUnlock(page, user);
    await openSettings(page);
    // S2: a switch that is off, against its card, 3:1
    const sw = page.getByTestId("picture-switch");
    await sw.click();
    await expect(sw).not.toBeChecked();
    await page.waitForTimeout(400); // the track's colour eases for 0.15 s: read it at rest
    const card = sw.locator("xpath=ancestor::*[contains(@class,'switch-row')][1]");
    expect(ratio(rgb(await style(sw, "background-color")), rgb(await style(card, "background-color")))).toBeGreaterThanOrEqual(3);
    await sw.click();
    // S3: the text on a danger button, 4.5:1
    await page.getByRole("button", { name: "Export unencrypted…" }).click();
    const danger = page.getByRole("dialog").locator(".btn-danger");
    expect(ratio(rgb(await style(danger, "color")), rgb(await style(danger, "background-color")))).toBeGreaterThanOrEqual(4.5);
  });
}

test("M7, M16, M6, M5: the drawer picture's top bubble clears the middle; Home's hover names sit outside the discs; names fade in after a change of view; the card keeps its height while the bubbles land", async ({ page }) => {
  const user = await signupWithKeys("vip");
  await loginAndUnlock(page, user);
  await makeDrawers(page, [["Cash tin", ["Flat", "Kitchen"]], ["Coin jar", ["Flat", "Kitchen"]], ["Shoe box", ["Flat", "Bedroom"]], ["Safe", ["Flat"]], ["Tool box", ["Garage"]], ["Wallet", []]]);
  const art = page.getByTestId("places-art");
  await expect(art).toHaveAttribute("data-count", "6");
  // M16: the names shown on hover are beside the discs (a disc scales while it glides; a name inside it scaled too)
  await expect(art.locator(".pa-disc .uc-bub-tip")).toHaveCount(0);
  await expect(art.locator(".pa-bub.place:not(.off) > .pa-tip")).toHaveText(["Flat", "Garage"]);
  // M6: the first drawing shows the names at once; after a pick they are drawn anew and fade in
  await expect(art.locator(".pa-label.enter")).toHaveCount(0);
  await art.locator(".pa-bub.place:not(.off)").filter({ has: page.locator(".pa-tip", { hasText: "Flat" }) }).locator(".uc-bub-hit").click();
  await expect(art).toHaveAttribute("data-view", "flat");
  await expect(art.locator(".pa-label.enter").first()).toBeAttached();
  // M5: back up to All the picture gets shorter (no row for the way back) — but not before its bubbles have landed
  await page.waitForTimeout(1000);
  const height = async () => (await art.boundingBox())!.height;
  const tall = await height();
  await art.locator(".pa-bub.center .uc-bub-hit").click();
  await expect(art).toHaveAttribute("data-view", "");
  expect(await height()).toBe(tall);
  await expect.poll(height, { timeout: 3000 }).toBeLessThan(tall);

  // M7: a drawer with one item: its bubble on top clears the middle one
  await page.getByTestId("tag-bar").getByRole("button", { name: /^All/ }).click();
  await page.getByTestId("drawer-row").filter({ hasText: "Wallet" }).click();
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Coins");
  await page.getByLabel("Currency", { exact: true }).fill("EUR");
  await page.getByLabel("Starting balance").fill("5");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const drawerArt = page.getByTestId("drawer-art");
  await page.waitForTimeout(900); // the bubble pops in
  const top = (await drawerArt.locator(".uc-bub.sat .uc-bub-disc").boundingBox())!;
  const mid = (await drawerArt.locator(".uc-bub.center .uc-bub-disc").boundingBox())!;
  const gap = Math.hypot(top.x + top.width / 2 - (mid.x + mid.width / 2), top.y + top.height / 2 - (mid.y + mid.height / 2)) - top.width / 2 - mid.width / 2;
  expect(gap).toBeGreaterThanOrEqual(4);
});

test("M19, M11: a tap just above a trail pill lands on it; Home's placeholder takes the size Home had", async ({ page }) => {
  const user = await signupWithKeys("vit");
  await loginAndUnlock(page, user);
  await makeDrawers(page, [["Cash tin", ["Flat"]]]);
  await page.getByTestId("drawer-row").filter({ hasText: "Cash tin" }).click();
  const pill = page.getByTestId("place-trail").getByRole("button", { name: "Flat" });
  const box = (await pill.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest(".trail-pill")?.textContent ?? null, [box.x + box.width / 2, box.y - 6]);
  expect(hit).toBe("Flat");
  // M11: Home remembered its top card's height; while the drawers load, the placeholder is that tall
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("home-totals").or(page.locator(".home-picture"))).toBeVisible();
  const want = await page.evaluate(() => (JSON.parse(localStorage.getItem("petty.home-shape") ?? "{}") as { top?: number }).top ?? 0);
  expect(want).toBeGreaterThan(122);
  await page.route("**/api/bootstrap", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.reload();
  const sk = page.getByTestId("home-skeleton").locator(".sk-total");
  await expect(sk).toBeVisible();
  expect(Math.round((await sk.boundingBox())!.height)).toBe(want);
});

test("F20, S24, S16: the 404 page's heading is its message; Delete account names the drawers only you own and has Cancel; the invite sheet has Cancel before the lookup", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("This page does not exist");

  const user = await signupWithKeys("vid");
  await loginAndUnlock(page, user);
  await makeDrawers(page, [["Cash tin", []], ["Shoe box", []]]);
  await page.getByTestId("drawer-row").filter({ hasText: "Cash tin" }).click();
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: "Invite someone" }).click();
  const invite = page.getByRole("dialog", { name: "Invite to this drawer" });
  await invite.getByRole("button", { name: "Cancel" }).click();
  await expect(invite).toHaveCount(0);

  await page.goto("/settings/delete");
  await expect(page.getByTestId("delete-sole").getByRole("listitem")).toHaveCount(2);
  expect((await page.getByTestId("delete-sole").getByRole("listitem").allTextContents()).sort()).toEqual(["Cash tin", "Shoe box"]);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).not.toHaveURL(/\/settings\/delete$/);
});

test("F19, F18, F14: one column of features on a phone, one width for the landing's sections on a laptop, the current language underlined", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const cols = await page.locator(".feature-grid").evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  expect(cols).toBe(1);
  await expect(page.locator(".landing-footer").getByRole("button", { name: "English", exact: true })).toHaveCSS("text-decoration-line", "underline");
  await page.setViewportSize({ width: 1280, height: 900 });
  const widths = await page.evaluate(() => ["section.landing-features", "#crypto", "footer.landing-footer"].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
});

test("S9: on a phone the places editor keeps a long name whole, and its row's buttons are 44 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const user = await signupWithKeys("vis9");
  await loginAndUnlock(page, user);
  await makeDrawers(page, [["Box", ["Zuhause", "Schlafzimmer"]]]);
  await page.goto("/places");
  // the bigger buttons first left "Schlafzimmer" 96 px and broke it mid-word; on a phone the row's "−" gives way (⋯ has Delete)
  const name = page.getByTestId("place-name").filter({ hasText: "Schlafzimmer" });
  const lines = await name.evaluate((b) => { const r = document.createRange(); r.selectNodeContents(b); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; });
  expect(lines).toBe(1);
  const row = page.getByTestId("place-row").filter({ has: name });
  for (const b of await row.locator(".tgrip, .tbtn:visible, .opts-btn").all()) {
    const box = (await b.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(36);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expect(row.getByTestId("place-minus")).toBeHidden();
});

test("PETTY-283: hovering a bubble that shows its name does not draw the name again; a bubble without a name still shows its tip", async ({ page }) => {
  const user = await signupWithKeys("vih");
  await loginAndUnlock(page, user);
  await makeDrawers(page, [["Cash tin", ["Flat", "Kitchen"]], ["Safe", ["Flat"]], ["Wallet", []]]);
  const art = page.getByTestId("places-art");
  await expect(art).toHaveAttribute("data-count", "3");
  await page.waitForTimeout(900);
  const bubble = (kind: string, name: string) => art.locator(`.pa-bub.${kind}:not(.off)`).filter({ has: page.locator(".pa-tip", { hasText: name }) });
  // Flat shows its name under it: no tip repeats it
  await bubble("place", "Flat").locator(".uc-bub-hit").hover();
  await expect(bubble("place", "Flat").locator(".pa-label")).toBeVisible();
  await expect(bubble("place", "Flat").locator(".pa-tip")).toBeHidden();
  // a small bubble round Flat has no name under it: its tip says what it is
  await bubble("sat", "Safe").locator(".uc-bub-hit").hover();
  await expect(bubble("sat", "Safe").locator(".pa-tip")).toBeVisible();
  // the drawer's own picture: an item's bubble shows its name, and no tip repeats it
  await page.getByTestId("drawer-row").filter({ hasText: "Wallet" }).click();
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Funty");
  await page.getByLabel("Currency", { exact: true }).fill("GBP");
  await page.getByLabel("Starting balance").fill("5");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const item = page.getByTestId("drawer-art").locator(".uc-bub.sat").filter({ hasText: "Funty" });
  await page.waitForTimeout(900);
  await item.locator(".uc-bub-hit").hover();
  await expect(item.locator(".uc-bub-name")).toBeVisible();
  await expect(item.locator(".uc-bub-tip")).toBeHidden();
});
