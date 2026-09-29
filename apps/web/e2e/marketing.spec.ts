/**
 * Captures landing screenshots per locale and theme. Run with MARKETING=1; writes to MARKETING_OUT.
 * MARKETING_LOCALES=de,fr limits the run (default: every language the app speaks, PETTY-249).
 */
import { mkdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, loginAndUnlock, pickTags, signupViaApi, test } from "./fixtures.js";

const OUT = process.env["MARKETING_OUT"] ?? "/tmp/petty-marketing";
test.skip(!process.env["MARKETING"], "marketing capture; set MARKETING=1");

const VP = { width: 390, height: 720 };
const ALL = ["en", "pl", "de", "es", "fr"] as const;
type Loc = (typeof ALL)[number];
const LOCS = (process.env["MARKETING_LOCALES"]?.split(",").map((x) => x.trim()) ?? [...ALL]).filter((x): x is Loc => (ALL as readonly string[]).includes(x));
/** The UI words the capture clicks, straight from the app's own dictionary for that language. */
function ui(loc: Loc) {
  const d = JSON.parse(readFileSync(new URL(`../src/i18n/${loc}.json`, import.meta.url), "utf8")) as { line: { ops: { withdraw: string }; entry: { comment: string } }; keypad: { decimal: string } };
  return { withdraw: d.line.ops.withdraw, comment: d.line.entry.comment, decimal: d.keypad.decimal };
}
const NAMES = {
  en: { d1: "Kitchen drawer", groceries: "Groceries", trip: "Trip fund", pass: "Passport", passText: "expires 2031", comment: "pizza friday", d2: "Bedroom box", dollars: "Dollar savings", ring: "Grandma's ring", ringText: "in the blue box" },
  pl: { d1: "Szuflada w kuchni", groceries: "Zakupy", trip: "Fundusz wakacyjny", pass: "Paszport", passText: "ważny do 2031", comment: "pizza w piątek", d2: "Pudełko w sypialni", dollars: "Dolary na później", ring: "Pierścionek babci", ringText: "w niebieskim pudełku" },
  de: { d1: "Küchenschublade", groceries: "Einkäufe", trip: "Urlaubskasse", pass: "Reisepass", passText: "gültig bis 2031", comment: "Pizza am Freitag", d2: "Box im Schlafzimmer", dollars: "Dollar-Rücklage", ring: "Omas Ring", ringText: "in der blauen Schachtel" },
  es: { d1: "Cajón de la cocina", groceries: "Compras", trip: "Fondo de viaje", pass: "Pasaporte", passText: "caduca en 2031", comment: "pizza del viernes", d2: "Caja del dormitorio", dollars: "Ahorro en dólares", ring: "Anillo de la abuela", ringText: "en la caja azul" },
  fr: { d1: "Tiroir de la cuisine", groceries: "Courses", trip: "Cagnotte vacances", pass: "Passeport", passText: "expire en 2031", comment: "pizza du vendredi", d2: "Boîte de la chambre", dollars: "Épargne en dollars", ring: "Bague de grand-mère", ringText: "dans la boîte bleue" },
} as const;
// Places, tags and icons (PETTY-59/64/66) live in the data and carry the locale too.
const PLACES = {
  en: { home: "Home", kitchen: "Kitchen", bedroom: "Bedroom", basement: "Basement", tags1: "cash, food", tags2: "travel" },
  pl: { home: "Dom", kitchen: "Kuchnia", bedroom: "Sypialnia", basement: "Piwnica", tags1: "gotówka, jedzenie", tags2: "podróż" },
  de: { home: "Zuhause", kitchen: "Küche", bedroom: "Schlafzimmer", basement: "Keller", tags1: "bargeld, essen", tags2: "reise" },
  es: { home: "Casa", kitchen: "Cocina", bedroom: "Dormitorio", basement: "Sótano", tags1: "efectivo, comida", tags2: "viaje" },
  fr: { home: "Maison", kitchen: "Cuisine", bedroom: "Chambre", basement: "Sous-sol", tags1: "espèces, courses", tags2: "voyage" },
} as const;
// Not only money (PETTY-77): a drawer of things — countable and single items.
const ITEMS = {
  en: { d3: "Basement tools", bits: "Drill bits", bitsUnit: "pcs", screws: "Screw boxes", screwsUnit: "boxes", keys: "Spare keys", keysText: "hook by the door", torch: "Torch", torchText: "charged in May" },
  pl: { d3: "Narzędzia w piwnicy", bits: "Wiertła", bitsUnit: "szt.", screws: "Pudełka wkrętów", screwsUnit: "pudełek", keys: "Zapasowe klucze", keysText: "haczyk przy drzwiach", torch: "Latarka", torchText: "naładowana w maju" },
  de: { d3: "Werkzeug im Keller", bits: "Bohrer", bitsUnit: "Stk.", screws: "Schraubenkisten", screwsUnit: "Kisten", keys: "Ersatzschlüssel", keysText: "Haken an der Tür", torch: "Taschenlampe", torchText: "im Mai geladen" },
  es: { d3: "Herramientas del sótano", bits: "Brocas", bitsUnit: "uds.", screws: "Cajas de tornillos", screwsUnit: "cajas", keys: "Llaves de repuesto", keysText: "gancho junto a la puerta", torch: "Linterna", torchText: "cargada en mayo" },
  fr: { d3: "Outils du sous-sol", bits: "Forets", bitsUnit: "pcs", screws: "Boîtes de vis", screwsUnit: "boîtes", keys: "Clés de secours", keysText: "crochet près de la porte", torch: "Lampe torche", torchText: "chargée en mai" },
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
/** Drawer options → Icon and colour: a colour first (it keeps the sheet open, PETTY-252), then the icon. */
async function setDrawerIcon(page: Page, label: string, colour?: string) {
  await page.getByRole("button", { name: "Drawer options" }).click();
  await page.getByTestId("drawer-icon").click();
  if (colour) {
    await page.getByTestId("color-picker").getByRole("button", { name: colour }).click();
    await expect(page.getByTestId("color-picker").getByRole("button", { name: colour })).toHaveAttribute("aria-pressed", "true");
  }
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
  await page.getByRole("button", { name: "Add item" }).click();
  if (kind === "single") await page.getByRole("group").getByRole("button", { name: "Single item" }).click();
  if (kind === "countable") await page.getByRole("group").getByRole("button", { name: "Countable" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  for (const [label, v] of Object.entries(extra)) await page.getByLabel(label, { exact: label === "Currency" }).fill(v);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}
async function confirmState(page: Page) {
  await page.getByRole("button", { name: "Mark as checked" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
}

test("capture home, drawer, items, keypad and places per locale and theme", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  test.setTimeout(150_000 * LOCS.length);
  for (const loc of LOCS) {
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
    await setDrawerIcon(sp, "Kitchen", "Clay");
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
    await sp.getByRole("button", { name: "Save", exact: true }).click();
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
    await setDrawerIcon(sp, "Bedroom", "Violet");
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
    await setDrawerIcon(sp, "Tools", "Slate");
    await setPlace(sp, [P.home, P.basement]);
    await setLineIcon(sp, I.bits, "Tools");
    await setLineIcon(sp, I.keys, "Key");
    await confirmState(sp);
    await setup.close();
    // capture in both themes; any language but English is switched on via localStorage before reload
    const U = ui(loc);
    for (const theme of ["light", "dark"] as const) {
      // reduced motion: every picture and list is captured in its final place, not mid-animation (PETTY-250)
      const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await loginAndUnlock(page, user);
      await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
      if (loc !== "en") { await page.evaluate((l) => localStorage.setItem("petty.locale", l), loc); await page.reload(); }
      await page.goto("/");
      await expect(page.getByTestId("drawer-row")).toHaveCount(3);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/home-${loc}-${theme}.png` });
      await page.goto(drawerUrl);
      await expect(page.getByRole("heading", { name: N.d1 })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/drawer-${loc}-${theme}.png` });
      await page.goto(lineUrl);
      await page.getByRole("button", { name: U.withdraw, exact: true }).click();
      for (const d of "40.50") await page.getByRole("group").getByRole("button", { name: d === "." ? U.decimal : d, exact: true }).click();
      await page.getByLabel(U.comment).fill(N.comment);
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
