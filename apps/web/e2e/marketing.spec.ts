/** Captures landing screenshots per locale and theme. Run with MARKETING=1; writes to MARKETING_OUT. */
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, loginAndUnlock, pickTags, signupViaApi, test } from "./fixtures.js";

const OUT = process.env["MARKETING_OUT"] ?? "/tmp/petty-marketing";
test.skip(!process.env["MARKETING"], "marketing capture; set MARKETING=1");

const VP = { width: 390, height: 720 };
const NAMES = {
  en: { d1: "Kitchen drawer", groceries: "Groceries", trip: "Trip fund", pass: "Passport", passText: "expires 2031", comment: "pizza friday", d2: "Bedroom box", dollars: "Dollar savings", ring: "Grandma's ring", ringText: "in the blue box" },
  pl: { d1: "Szuflada w kuchni", groceries: "Zakupy", trip: "Fundusz wakacyjny", pass: "Paszport", passText: "ważny do 2031", comment: "pizza w piątek", d2: "Pudełko w sypialni", dollars: "Dolary na później", ring: "Pierścionek babci", ringText: "w niebieskim pudełku" },
} as const;
const UI = { en: { withdraw: "Withdraw", comment: "Comment (optional)" }, pl: { withdraw: "Wypłata", comment: "Komentarz (opcjonalnie)" } } as const;
// Places, tags and icons (PETTY-59/64/66) live in the data and carry the locale too.
const PLACES = { en: { home: "Home", kitchen: "Kitchen", bedroom: "Bedroom", basement: "Basement", tags1: "cash, food", tags2: "travel" }, pl: { home: "Dom", kitchen: "Kuchnia", bedroom: "Sypialnia", basement: "Piwnica", tags1: "gotówka, jedzenie", tags2: "podróż" } } as const;
// Not only money (PETTY-77): a drawer of things — countable and single items.
const ITEMS = {
  en: { d3: "Basement tools", bits: "Drill bits", bitsUnit: "pcs", screws: "Screw boxes", screwsUnit: "boxes", keys: "Spare keys", keysText: "hook by the door", torch: "Torch", torchText: "charged in May" },
  pl: { d3: "Narzędzia w piwnicy", bits: "Wiertła", bitsUnit: "szt.", screws: "Pudełka wkrętów", screwsUnit: "pudełek", keys: "Zapasowe klucze", keysText: "haczyk przy drzwiach", torch: "Latarka", torchText: "naładowana w maju" },
} as const;

/** Drawer options -> Place: pick an existing node or create it inside the current one (one level per round). */
async function setPlace(page: Page, segments: readonly string[]) {
  for (const seg of segments) {
    await page.getByRole("button", { name: "Drawer options" }).click();
    await page.getByTestId("drawer-tags").click();
    const picker = page.getByTestId("drawer-place-picker");
    const existing = picker.getByTestId("place-option").filter({ hasText: new RegExp(`^${seg}$`) });
    if (await existing.count()) await existing.first().click();
    else { await picker.getByTestId("place-new").fill(seg); await picker.getByRole("button", { name: "Add place" }).click(); }
    await expect(page.getByRole("dialog")).toBeHidden();
  }
}
async function setDrawerIcon(page: Page, label: string) {
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-icon").click();
  await page.getByTestId("icon-picker").getByRole("button", { name: label }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
/** From the drawer: open the line, use its ⋯ (PETTY-71), come back. */
async function lineOption(page: Page, name: string, option: string) {
  await page.getByRole("button", { name: `Open ${name}` }).click();
  await page.getByRole("button", { name: `Options for ${name}` }).click();
  await page.getByRole("button", { name: option, exact: true }).click();
}
async function setLineTags(page: Page, name: string, tags: string) {
  await lineOption(page, name, "Tags");
  await pickTags(page, tags.split(",").map((x) => x.trim()).filter(Boolean));
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Back" }).click();
}
async function setLineIcon(page: Page, name: string, label: string) {
  await lineOption(page, name, "Icon");
  await page.getByTestId("line-icon-picker").getByRole("button", { name: label }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Back" }).click();
}

async function addLine(page: Page, kind: "money" | "countable" | "single", name: string, extra: Record<string, string>) {
  await page.getByRole("button", { name: "Add line" }).click();
  if (kind === "single") await page.getByRole("group").getByRole("button", { name: "Single item" }).click();
  if (kind === "countable") await page.getByRole("group").getByRole("button", { name: "Countable" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  for (const [label, v] of Object.entries(extra)) await page.getByLabel(label, { exact: label === "Currency" }).fill(v);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}
async function confirmState(page: Page) {
  await page.getByRole("button", { name: "Confirm state" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
}

test("capture home, drawer, items, keypad and places per locale and theme", async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  for (const loc of ["en", "pl"] as const) {
    const N = NAMES[loc];
    const user = await signupViaApi("Ola");
    // build the data once per locale (EN UI labels; the DATA carries the locale)
    const setup = await browser.newContext({ viewport: VP, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const sp = await setup.newPage();
    await loginAndUnlock(sp, user);
    await sp.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
    await sp.getByRole("button", { name: "Add drawer" }).click();
    await sp.getByLabel("Name", { exact: true }).fill(N.d1);
    await sp.getByRole("button", { name: "Save" }).click();
    await expect(sp.getByRole("heading", { name: N.d1 })).toBeVisible();
    const drawerUrl = new URL(sp.url()).pathname;
    await addLine(sp, "money", N.groceries, { Currency: "EUR", "Starting balance": "1250" });
    await addLine(sp, "money", N.trip, { Currency: "USD", "Starting balance": "420" });
    await addLine(sp, "single", N.pass, { Text: N.passText });
    const P = PLACES[loc];
    await setDrawerIcon(sp, "Kitchen");
    await setPlace(sp, [P.home, P.kitchen]);
    await setLineTags(sp, N.groceries, P.tags1);
    await setLineIcon(sp, N.groceries, "Banknote");
    await setLineTags(sp, N.trip, P.tags2);
    await setLineIcon(sp, N.trip, "Travel");
    // the trip fund is savings, not drawer cash: out of the total, so the drawer shows both totals
    await sp.getByRole("button", { name: `Open ${N.trip}` }).click();
    await sp.getByRole("button", { name: `Options for ${N.trip}` }).click();
    await sp.getByTestId("line-counted-switch").click();
    await expect(sp.getByTestId("line-counted-switch")).not.toBeChecked();
    await sp.keyboard.press("Escape");
    await sp.getByRole("button", { name: "Back" }).click();
    await sp.getByRole("button", { name: `Open ${N.groceries}` }).click();
    await sp.getByRole("button", { name: "Withdraw", exact: true }).click();
    for (const d of "40.50") await sp.getByRole("group").getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click();
    await sp.getByLabel("Comment (optional)").fill(N.comment);
    const lineUrl = new URL(sp.url()).pathname;
    await sp.getByRole("button", { name: "Review" }).click();
    await sp.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(sp.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
    await sp.getByRole("button", { name: "Back" }).click();
    await confirmState(sp);
    await sp.goto("/");
    await sp.getByRole("button", { name: "Add drawer" }).click();
    await sp.getByLabel("Name", { exact: true }).fill(N.d2);
    await sp.getByRole("button", { name: "Save" }).click();
    await expect(sp.getByRole("heading", { name: N.d2 })).toBeVisible();
    await addLine(sp, "money", N.dollars, { Currency: "USD", "Starting balance": "300" });
    await addLine(sp, "single", N.ring, { Text: N.ringText });
    await setDrawerIcon(sp, "Bedroom");
    await setPlace(sp, [P.home, P.bedroom]);
    await confirmState(sp);
    // a drawer of things: an inventory, not cash
    const I = ITEMS[loc];
    await sp.goto("/");
    await sp.getByRole("button", { name: "Add drawer" }).click();
    await sp.getByLabel("Name", { exact: true }).fill(I.d3);
    await sp.getByRole("button", { name: "Save" }).click();
    await expect(sp.getByRole("heading", { name: I.d3 })).toBeVisible();
    const itemsUrl = new URL(sp.url()).pathname;
    await addLine(sp, "countable", I.bits, { "Unit (optional)": I.bitsUnit, "Starting count": "24" });
    await addLine(sp, "countable", I.screws, { "Unit (optional)": I.screwsUnit, "Starting count": "6" });
    await addLine(sp, "single", I.keys, { Text: I.keysText });
    await addLine(sp, "single", I.torch, { Text: I.torchText });
    await setDrawerIcon(sp, "Tools");
    await setPlace(sp, [P.home, P.basement]);
    await setLineIcon(sp, I.bits, "Tools");
    await setLineIcon(sp, I.keys, "Key");
    await confirmState(sp);
    await setup.close();
    // capture in both themes; PL flips the UI language via localStorage before reload
    for (const theme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
      const page = await ctx.newPage();
      await loginAndUnlock(page, user);
      await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
      if (loc === "pl") { await page.evaluate(() => localStorage.setItem("petty.locale", "pl")); await page.reload(); }
      await page.goto("/");
      await expect(page.getByTestId("drawer-row")).toHaveCount(3);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/home-${loc}-${theme}.png` });
      await page.goto(drawerUrl);
      await expect(page.getByRole("heading", { name: N.d1 })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/drawer-${loc}-${theme}.png` });
      await page.goto(lineUrl);
      await page.getByRole("button", { name: UI[loc].withdraw, exact: true }).click();
      for (const d of "40.50") await page.getByRole("group").getByRole("button", { name: d === "." ? (loc === "pl" ? "Przecinek dziesiętny" : "Decimal point") : d, exact: true }).click().catch(async () => { if (d === ".") await page.getByRole("group").getByRole("button", { name: ",", exact: true }).click(); });
      await page.getByLabel(UI[loc].comment).fill(N.comment);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/entry-${loc}-${theme}.png` });
      await page.goto(itemsUrl);
      await expect(page.getByRole("heading", { name: I.d3 })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/items-${loc}-${theme}.png` });
      await page.goto("/places");
      await expect(page.getByTestId("place-row")).toHaveCount(4);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/places-${loc}-${theme}.png` });
      await ctx.close();
    }
  }
});
