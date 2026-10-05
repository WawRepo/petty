/**
 * Footage for the promo films (PETTY-324). Run with PROMO=1; writes to PROMO_OUT.
 *
 * One account (Ben) gets the landing page's six examples as real, encrypted data — the same places,
 * drawers, items, amounts and notes as "One idea, many uses" (UseCases.tsx), words from the dictionary —
 * and the drawers are shared the way the examples say: the trip kitty with Anna and Cara (each adds
 * what they paid, in their own browser), the lent things with Tom, the family safe read-only with Anna.
 * Then the app is filmed in short clips (scripts/promo-video.ts cuts them into the films).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Browser, CDPSession, Locator, Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createRecoveryVault, createVault, exportPublicKeys, generateRecoveryCode, generateUserKeys, signingKeyId } from "@petty/crypto";
import { API, expect, loginAndUnlock, makeJoinLink, shareViaApi, test, type TestUserWithKeys } from "./fixtures.js";

const OUT = process.env["PROMO_OUT"] ?? "/tmp/petty-promo";
test.skip(!process.env["PROMO"], "promo footage; set PROMO=1");

const LOC = "en";
type Dict = Record<string, unknown>;
const DICT = JSON.parse(readFileSync(new URL(`../src/i18n/${LOC}.json`, import.meta.url), "utf8")) as Dict;
/** A dictionary string by its dotted key. */
function w(key: string): string {
  const v = key.split(".").reduce<unknown>((o, k) => (o as Dict | undefined)?.[k], DICT);
  if (typeof v !== "string") throw new Error(`no string ${key}`);
  return v;
}
const uc = (key: string) => w(`landing.uses.cases.${key}`);

/** The examples' amounts and icons, as in UseCases.tsx; names and notes come from the dictionary. */
type Item =
  | { key: string; kind: "money"; icon: string; minor: number; currency: string }
  | { key: string; kind: "countable"; icon: string }
  | { key: string; kind: "single"; icon: string };
interface Drawer { key: string; icon: string; color: string; place: readonly string[]; items: readonly Item[] }
const money = (key: string, icon: string, minor: number, currency: string): Item => ({ key, kind: "money", icon, minor, currency });
const count = (key: string, icon: string): Item => ({ key, kind: "countable", icon });
const single = (key: string, icon: string): Item => ({ key, kind: "single", icon });
const CASES: readonly { key: string; drawers: readonly Drawer[] }[] = [
  { key: "workshop", drawers: [
    { key: "desk", icon: "box", color: "slate", place: ["home", "basement", "workshop"], items: [count("zipties", "box"), count("tape", "box")] },
    { key: "pegboard", icon: "wrench", color: "slate", place: ["home", "basement", "workshop"], items: [single("hammer", "wrench"), single("drill", "wrench")] },
  ] },
  { key: "trip", drawers: [
    { key: "kitty", icon: "plane", color: "teal", place: ["trips", "malaysia"], items: [money("anna", "wallet", 60000, "MYR"), money("ben", "wallet", 15000, "MYR"), money("cara", "wallet", 4500, "MYR")] },
    { key: "next", icon: "plane", color: "blue", place: ["trips", "thailand"], items: [count("passes", "card")] },
  ] },
  { key: "accounts", drawers: [
    { key: "pension", icon: "bank", color: "violet", place: ["paperwork"], items: [money("fund", "bank", 4820000, "EUR")] },
    { key: "brokerage", icon: "briefcase", color: "violet", place: ["paperwork"], items: [money("shares", "briefcase", 315000, "USD"), money("cash", "wallet", 42000, "USD")] },
    { key: "savings", icon: "piggy-bank", color: "violet", place: ["paperwork"], items: [money("deposit", "piggy-bank", 1240000, "EUR")] },
  ] },
  { key: "cash", drawers: [
    { key: "tin", icon: "coins", color: "green", place: ["home", "kitchen"], items: [money("groceries", "banknote", 24000, "EUR"), money("coins", "coins", 3650, "EUR")] },
    { key: "envelope", icon: "archive", color: "olive", place: ["home", "bedroom"], items: [money("emergency", "banknote", 50000, "EUR"), money("holiday", "plane", 15000, "USD")] },
  ] },
  { key: "lent", drawers: [
    { key: "lent", icon: "tag", color: "clay", place: ["home", "garage"], items: [single("drill", "wrench"), single("ladder", "box"), count("chairs", "box")] },
    { key: "borrowed", icon: "gift", color: "clay", place: ["home", "garage"], items: [single("tent", "backpack")] },
  ] },
  { key: "family", drawers: [
    { key: "documents", icon: "note", color: "rose", place: ["home", "bedroom", "wardrobe", "safe"], items: [count("passports", "note"), count("certificates", "note")] },
    { key: "valuables", icon: "gem", color: "rose", place: ["home", "bedroom", "wardrobe", "safe"], items: [single("ring", "gem"), single("carkey", "key")] },
  ] },
];
/** The place tree in the order the films show it: home first, then the trips, then the paperwork. */
const TREE = [
  ["home", [["kitchen", []], ["bedroom", [["wardrobe", [["safe", []]]]]], ["basement", [["workshop", []]]], ["garage", []]]],
  ["trips", [["malaysia", []], ["thailand", []]]],
  ["paperwork", []],
] as const;
/** Every place name the cases use, by key (a place's name is the same in every case that has it). */
const PLACE: Record<string, string> = {};
for (const c of CASES) for (const d of c.drawers) for (const p of d.place) PLACE[p] = uc(`${c.key}.places.${p}`);
type Tree = readonly (readonly [string, Tree])[];
const placeTree = (t: Tree): unknown[] => t.map(([k, kids]) => ({ name: PLACE[k], children: placeTree(kids) }));

/** What the browser seeds: the drawers with their lines ready to add, and the first entry of each. */
interface SeedLine { id: string; kind: Item["kind"]; name: string; icon: string; currency?: string; unit?: string; text?: string; start?: number; comment?: string; by?: string }
interface SeedDrawer { key: string; name: string; icon: string; color: string; place: string[]; lines: SeedLine[]; checked: boolean }
function seedPlan(): SeedDrawer[] {
  return CASES.flatMap((c) => c.drawers.map((d) => ({
    key: d.key, name: uc(`${c.key}.drawers.${d.key}.name`), icon: d.icon, color: d.color, place: d.place.map((p) => PLACE[p]!),
    // the accounts are checked once a year, the cash tin today; the savings drawer is left for the film to check
    checked: (c.key === "accounts" && d.key !== "savings") || d.key === "tin",
    lines: d.items.map((it): SeedLine => {
      const base = `${c.key}.items.${it.key}`;
      const name = uc(`${base}.name`);
      const note = (() => { try { return uc(`${base}.note`); } catch { return undefined; } })();
      const id = crypto.randomUUID();
      if (it.kind === "money") return { id, kind: "money", name, icon: it.icon, currency: it.currency, start: it.minor, ...(note ? { comment: note } : {}), ...(c.key === "trip" ? { by: it.key } : {}) };
      if (it.kind === "single") return { id, kind: "single", name, icon: it.icon, text: note ?? "" };
      const m = /^(\d+)\s*(.*)$/.exec(uc(`${base}.value`));
      if (!m) throw new Error(`no count in ${base}.value`);
      return { id, kind: "countable", name, icon: it.icon, unit: m[2]!, start: Number(m[1]), ...(note ? { comment: note } : {}) };
    }),
  })));
}

/** In the signed-in, unlocked page: the app's own store modules (dev build), so the data goes in exactly as the app writes it. */
async function seedInBrowser(page: Page, plan: SeedDrawer[], tree: unknown[], me: string): Promise<Record<string, string>> {
  return page.evaluate(async ({ plan, tree, me }) => {
    const find = (re: RegExp, path: string) => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => re.test(n)).at(-1) ?? path;
    type Store = typeof import("../src/lib/drawers.js");
    const D = (await import(find(/\/src\/lib\/drawers\.ts(\?|$)/, "/src/lib/drawers.ts"))) as Store;
    const P = (await import(find(/\/src\/lib\/places\.ts(\?|$)/, "/src/lib/places.ts"))) as typeof import("../src/lib/places.js");
    const ids: Record<string, string> = {};
    for (const d of plan) {
      const id = await D.createDrawer(d.name, d.place);
      ids[d.key] = id;
      const lines = d.lines.map((l) => l.kind === "money" ? { id: l.id, kind: "money" as const, name: l.name, currency: l.currency!, exponent: 2 }
        : l.kind === "countable" ? { id: l.id, kind: "countable" as const, name: l.name, unit: l.unit! } : { id: l.id, kind: "single" as const, name: l.name, text: l.text! });
      await D.mutateDocument(id, [
        { type: "set_icon", icon: d.icon }, { type: "set_color", color: d.color === "green" ? null : d.color },
        ...lines.flatMap((line, i) => [{ type: "add_line" as const, line }, { type: "set_line_icon" as const, line_id: line.id, icon: d.lines[i]!.icon }]),
      ]);
      // a trip item is added by its person, in their own browser (seedEntryAs)
      for (const [i, l] of d.lines.entries()) if (l.start && (!l.by || l.by === me)) await D.appendEntry(id, lines[i]!, "add", l.start, l.comment ? { comment: l.comment } : {});
    }
    await P.savePlaceTree(tree as Parameters<typeof P.savePlaceTree>[0]);
    return ids;
  }, { plan, tree, me });
}

/** Mark a drawer as checked, the way ConfirmStateSheet does: every item's count at this moment. */
async function checkInBrowser(page: Page, drawerId: string): Promise<void> {
  await page.evaluate(async (drawerId) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/src\/lib\/drawers\.ts(\?|$)/.test(n)).at(-1) ?? "/src/lib/drawers.ts";
    const D = (await import(url)) as typeof import("../src/lib/drawers.js");
    const view = D.getDrawers().drawers.get(drawerId)!;
    const lines = view.doc!.lines.map((l) => {
      if (l.kind === "single") return { line_id: l.id, kind: l.kind, balance: null, present: true, head_seq: null };
      const f = D.lineFold(view, l.id);
      return { line_id: l.id, kind: l.kind, balance: f.balance, present: null, head_seq: f.headSeq };
    });
    const verification = { id: crypto.randomUUID(), author_id: view.summary.owner_id, logged_at: new Date().toISOString(), comment: "", lines };
    await D.mutateDocument(drawerId, [{ type: "append_verification", verification }], { verification: true });
  }, drawerId);
}

/** Another member adds their own first entry to a shared drawer, in their own browser. */
async function seedEntryAs(browser: Browser, user: TestUserWithKeys, drawerId: string, line: SeedLine): Promise<void> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAndUnlock(page, user);
  await page.evaluate(async ({ drawerId, line }) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/src\/lib\/drawers\.ts(\?|$)/.test(n)).at(-1) ?? "/src/lib/drawers.ts";
    const D = (await import(url)) as typeof import("../src/lib/drawers.js");
    for (let i = 0; i < 100 && !D.getDrawers().drawers.get(drawerId)?.doc; i++) await new Promise((r) => setTimeout(r, 100));
    const l = D.getDrawers().drawers.get(drawerId)!.doc!.lines.find((x) => x.id === line.id)!;
    await D.appendEntry(drawerId, l, "add", line.start!, line.comment ? { comment: line.comment } : {});
  }, { drawerId, line });
  await ctx.close();
}

/**
 * A demo account, like fixtures' signupWithKeys but with a plain address (name.run@example.com):
 * the sharing chapter types Cara's on screen.
 */
async function signupDemo(name: string): Promise<TestUserWithKeys> {
  const run = randomBytes(3).toString("hex");
  const email = `${name.toLowerCase()}.${run}@example.com`, password = `password-${name}-${run}`, passphrase = `vault ${name} ${run} passphrase`;
  const keys = await generateUserKeys();
  const pub = await exportPublicKeys(keys);
  const recoveryCode = generateRecoveryCode();
  const res = await fetch(`${API}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    join_token: await makeJoinLink(), email, password, display_name: name, locale: LOC,
    keys: { ecdh_pub: pub.ecdh, ecdsa_pub: pub.ecdsa, sig_key_id: await signingKeyId(pub.ecdsa) },
    vault: await createVault(passphrase, keys), recovery_vault: await createRecoveryVault(recoveryCode, keys),
  }) });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return { name, email, password, passphrase, keys, ecdhPub: pub.ecdh, recoveryCode };
}

/**
 * A camera on one page: Chrome's screencast at the device's pixels, each frame saved with its time.
 * The frames come only when the screen changes; the cutter holds each until the next.
 */
class Camera {
  private cdp: CDPSession | null = null;
  private frames: { file: string; t: number }[] = [];
  private marks: Record<string, number> = {};
  private dir = "";
  private t0 = 0;
  constructor(private readonly page: Page) {}
  async start(name: string): Promise<void> {
    this.dir = `${OUT}/clips/${name}`;
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.marks = {};
    const cdp = await this.page.context().newCDPSession(this.page);
    cdp.on("Page.screencastFrame", (f) => {
      const file = `f${String(this.frames.length + 1).padStart(5, "0")}.jpg`;
      writeFileSync(`${this.dir}/${file}`, Buffer.from(f.data, "base64"));
      this.frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    });
    this.cdp = cdp;
    this.t0 = Date.now() / 1000;
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VP.width * DSF, maxHeight: VP.height * DSF, everyNthFrame: 1 });
  }
  /** A named moment in the clip, in seconds from its start: the cutter takes its pieces from these. */
  mark(name: string): void { this.marks[name] = Date.now() / 1000 - this.t0; }
  async stop(): Promise<void> {
    const end = Date.now() / 1000;
    await this.cdp!.send("Page.stopScreencast");
    await this.cdp!.detach();
    this.cdp = null;
    writeFileSync(`${this.dir}/frames.json`, JSON.stringify({ t0: this.t0, end, frames: this.frames, marks: this.marks }));
  }
}

const VP = { width: 390, height: 844 };
const DSF = 2;
/** A finger: a soft dot where each tap lands (the film has no pointer). */
const TOUCH_DOTS = `addEventListener("pointerdown", (e) => {
  const d = document.createElement("div");
  Object.assign(d.style, { position: "fixed", left: (e.clientX - 24) + "px", top: (e.clientY - 24) + "px", width: "48px", height: "48px", borderRadius: "50%",
    background: "rgba(28, 26, 23, 0.22)", border: "2px solid rgba(255, 255, 255, 0.7)", pointerEvents: "none", zIndex: "2147483647" });
  document.documentElement.appendChild(d);
  d.animate([{ transform: "scale(0.55)", opacity: 1 }, { transform: "scale(1.35)", opacity: 0 }], { duration: 650, easing: "cubic-bezier(.2,.7,.3,1)" }).onfinish = () => d.remove();
}, true);`;

/** A pause the viewer can follow, then a tap. */
async function tap(page: Page, target: Locator, before = 650): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(before);
  await target.click();
}
/** Scroll the page to y over ms, eased, the way a thumb would. */
async function glide(page: Page, y: number, ms = 1400): Promise<void> {
  await page.evaluate(([to, ms]) => new Promise<void>((done) => {
    const from = scrollY, start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      scrollTo(0, from + (to - from) * (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2));
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  }), [y, ms] as const);
}
/** Put an element's top at the given height on the screen, at once (before the camera runs). */
async function placeAt(page: Page, target: Locator, top: number): Promise<void> {
  const y = await target.evaluate((el, top) => el.getBoundingClientRect().top + scrollY - top, top);
  await page.evaluate((y) => scrollTo(0, y), y);
}
async function home(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("home")).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("drawer-row").first()).toBeVisible();
  await page.waitForTimeout(1200);
}

test("seed the six examples and film the app", async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const [ben, anna, cara, tom] = await Promise.all(["Ben", "Anna", "Cara", "Tom"].map((n) => signupDemo(n)));
  const plan = seedPlan();
  const setup = await browser.newContext();
  const sp = await setup.newPage();
  await loginAndUnlock(sp, ben!);
  await sp.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const ids = await seedInBrowser(sp, plan, placeTree(TREE as unknown as Tree), "ben");
  for (const key of ["pension", "brokerage", "tin"]) await checkInBrowser(sp, ids[key]!);
  await setup.close();

  await shareViaApi(ben!, ids["kitty"]!, anna!, "write");
  await shareViaApi(ben!, ids["kitty"]!, cara!, "write");
  await shareViaApi(ben!, ids["lent"]!, tom!, "write");
  await shareViaApi(ben!, ids["documents"]!, anna!, "read");
  await shareViaApi(ben!, ids["valuables"]!, anna!, "read");
  const kitty = plan.find((d) => d.key === "kitty")!;
  await seedEntryAs(browser, anna!, ids["kitty"]!, kitty.lines.find((l) => l.by === "anna")!);
  await seedEntryAs(browser, cara!, ids["kitty"]!, kitty.lines.find((l) => l.by === "cara")!);
  expect(Object.keys(ids)).toHaveLength(13);

  // the films are of a phone, light theme, motion on
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF, isMobile: true, hasTouch: true, colorScheme: "light" });
  await ctx.addInitScript(TOUCH_DOTS);
  const page = await ctx.newPage();
  await loginAndUnlock(page, ben!);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  const cam = new Camera(page);
  const chip = (name: string) => page.getByTestId("tag-bar").getByRole("button", { name: new RegExp(`^${name}\\b`) });
  const row = (name: string) => page.getByRole("button", { name: `Open ${name}` });
  const D = (key: string) => uc(`${CASES.find((c) => c.drawers.some((d) => d.key === key))!.key}.drawers.${key}.name`);

  // home: the total and the places as a picture, then down the drawers
  await home(page);
  await cam.start("home");
  await page.waitForTimeout(3500);
  cam.mark("list");
  await glide(page, 900, 2600);
  await page.waitForTimeout(900);
  await glide(page, 0, 1800);
  await page.waitForTimeout(800);
  await cam.stop();

  // workshop: find anything — search, the hit with its place, into the drawer
  await home(page);
  await cam.start("workshop");
  await page.waitForTimeout(500);
  await tap(page, page.getByTestId("home-search-toggle"), 300);
  await page.getByTestId("home-search").locator("input").pressSequentially(uc("workshop.items.zipties.name").slice(0, 3).toLowerCase(), { delay: 220 });
  cam.mark("found");
  await page.waitForTimeout(1300);
  await tap(page, page.getByTestId("drawer-row").first(), 300);
  cam.mark("drawer");
  await page.waitForTimeout(2600);
  await cam.stop();

  // trip: the trip places, the shared kitty, Anna's own entry
  await home(page);
  await cam.start("trip");
  await tap(page, chip(PLACE["trips"]!), 600);
  await page.waitForTimeout(900);
  await tap(page, row(D("kitty")), 500);
  cam.mark("drawer");
  await page.waitForTimeout(2200);
  await tap(page, page.getByRole("button", { name: `Open ${uc("trip.items.anna.name")}` }), 300);
  cam.mark("line");
  await page.waitForTimeout(2200);
  await cam.stop();

  // accounts: the paperwork, two checked; check the third
  await home(page);
  await cam.start("accounts");
  await tap(page, chip(PLACE["paperwork"]!), 600);
  cam.mark("list");
  await page.waitForTimeout(1300);
  await tap(page, row(D("savings")), 300);
  await page.waitForTimeout(900);
  await tap(page, page.getByRole("button", { name: "Mark as checked" }).first(), 400);
  cam.mark("sheet");
  await tap(page, page.getByRole("dialog").getByRole("button", { name: "Mark as checked" }), 900);
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
  cam.mark("checked");
  await page.waitForTimeout(1800);
  await cam.stop();

  // lent: the garage drawers — who has what, and since when
  await home(page);
  await placeAt(page, row(D("lent")), 260);
  await page.waitForTimeout(500);
  await cam.start("lent");
  await tap(page, row(D("lent")), 700);
  cam.mark("drawer");
  await page.waitForTimeout(1800);
  await glide(page, 300, 1500);
  await page.waitForTimeout(1200);
  await cam.stop();

  // family: the safe, deep in the bedroom; Anna may read it, not change it
  await home(page);
  await placeAt(page, row(D("valuables")), 260);
  await page.waitForTimeout(500);
  await cam.start("family");
  await tap(page, row(D("valuables")), 700);
  cam.mark("drawer");
  await page.waitForTimeout(2000);
  await tap(page, page.getByRole("button", { name: "Drawer options" }), 200);
  await tap(page, page.getByRole("dialog").getByRole("button", { name: "Members" }), 600);
  cam.mark("members");
  await page.waitForTimeout(2200);
  await cam.stop();

  // all together: the places one by one, then all of them
  await home(page);
  await cam.start("all");
  await tap(page, chip(PLACE["home"]!), 700);
  await page.waitForTimeout(1300);
  await tap(page, page.getByTestId("tag-bar").getByRole("button", { name: /^All\b/ }), 300);
  await page.waitForTimeout(300);
  await tap(page, chip(PLACE["trips"]!), 500);
  await page.waitForTimeout(1300);
  await tap(page, page.getByTestId("tag-bar").getByRole("button", { name: /^All\b/ }), 300);
  cam.mark("all");
  await page.waitForTimeout(1800);
  await cam.stop();

  // the places tree
  await page.goto("/places");
  await expect(page.getByTestId("place-row").first()).toBeVisible();
  await page.waitForTimeout(1000);
  await cam.start("places");
  await page.waitForTimeout(800);
  await glide(page, 500, 2600);
  await page.waitForTimeout(1000);
  await cam.stop();

  // the AI scene's phone: the drawer the answer names
  await page.goto(`/drawers/${ids["valuables"]}`);
  await expect(page.getByRole("heading", { name: D("valuables") })).toBeVisible();
  await page.waitForTimeout(1200);
  await cam.start("ai");
  await page.waitForTimeout(5000);
  await cam.stop();
  // ---- the feature tour (PETTY-325): one clip per chapter; the cash and accounts clips above serve it too

  // the idea: a place, the drawer in it, an item in the drawer
  await home(page);
  await cam.start("t-core");
  await page.waitForTimeout(1200);
  await tap(page, chip(PLACE["home"]!), 300);
  cam.mark("place");
  await page.waitForTimeout(1200);
  await tap(page, chip(PLACE["kitchen"]!), 300);
  await page.waitForTimeout(1000);
  await tap(page, row(D("tin")), 300);
  cam.mark("drawer");
  await page.waitForTimeout(1700);
  await tap(page, row(uc("cash.items.groceries.name")), 300);
  cam.mark("item");
  await page.waitForTimeout(1800);
  await cam.stop();

  // finding your way: up the drawer's path, through the places, back to all
  await page.goto(`/drawers/${ids["valuables"]}`);
  await expect(page.getByRole("heading", { name: D("valuables") })).toBeVisible();
  await page.waitForTimeout(1200);
  await cam.start("t-nav");
  await page.waitForTimeout(900);
  await tap(page, page.getByTestId("place-trail").getByRole("button", { name: PLACE["bedroom"]!, exact: true }), 300);
  cam.mark("home");
  await page.waitForTimeout(1500);
  await tap(page, chip(PLACE["wardrobe"]!), 300);
  await page.waitForTimeout(1300);
  await tap(page, page.getByTestId("tag-bar").getByRole("button", { name: /^All\b/ }), 300);
  await page.waitForTimeout(1500);
  await cam.stop();

  // places: a new one inside Home, then one step up the list
  const GARDEN = "Garden";
  await page.goto("/places");
  await expect(page.getByTestId("place-row").first()).toBeVisible();
  await page.waitForTimeout(1000);
  await cam.start("t-places");
  await page.waitForTimeout(700);
  await tap(page, page.getByRole("button", { name: `Add a place inside ${PLACE["home"]}` }), 300);
  await page.getByRole("dialog").getByLabel("Name").pressSequentially(GARDEN, { delay: 70 });
  await tap(page, page.getByRole("dialog").getByRole("button", { name: "Save" }), 300);
  await expect(page.getByRole("dialog")).toBeHidden();
  cam.mark("added");
  const garden = page.getByTestId("place-row").filter({ hasText: GARDEN });
  await glide(page, await garden.evaluate((el) => el.getBoundingClientRect().top + scrollY - 420), 900);
  await page.waitForTimeout(500);
  await tap(page, garden.getByRole("button", { name: `Options for ${GARDEN}` }), 300);
  await tap(page, page.getByRole("dialog").getByRole("button", { name: "Move up" }), 700);
  await expect(page.getByRole("dialog")).toBeHidden();
  cam.mark("moved");
  await page.waitForTimeout(1400);
  await cam.stop();

  // a new drawer, made in the new place
  const SHED = "Garden shed";
  await home(page);
  await placeAt(page, page.getByRole("button", { name: "Add drawer" }), 560);
  await page.waitForTimeout(500);
  await cam.start("t-drawer");
  await tap(page, page.getByRole("button", { name: "Add drawer" }), 700);
  await page.getByRole("dialog").getByLabel("Name", { exact: true }).pressSequentially(SHED, { delay: 70 });
  const picker = page.getByTestId("add-place-picker");
  await tap(page, picker.getByRole("button", { name: w("places.expand").replace("{name}", PLACE["home"]!) }), 300);
  await tap(page, picker.getByTestId("place-option").filter({ hasText: new RegExp(`^${GARDEN}$`) }), 400);
  await tap(page, page.getByRole("dialog").getByRole("button", { name: "Save" }), 400);
  await expect(page.getByRole("heading", { name: SHED })).toBeVisible();
  cam.mark("made");
  await page.waitForTimeout(1600);
  await cam.stop();

  // items of each kind
  await cam.start("t-items");
  await tap(page, page.getByRole("button", { name: "Add item" }), 500);
  await tap(page, page.getByRole("group").getByRole("button", { name: "Countable" }), 300);
  await page.getByLabel("Name", { exact: true }).pressSequentially("Seed packets", { delay: 45 });
  await page.getByLabel("Unit (optional)").pressSequentially("packs", { delay: 45 });
  await page.getByLabel("Starting count").pressSequentially("12", { delay: 90 });
  await tap(page, page.getByRole("button", { name: "Add", exact: true }), 300);
  await expect(page.getByRole("dialog")).toBeHidden();
  cam.mark("first");
  await page.waitForTimeout(900);
  await tap(page, page.getByRole("button", { name: "Add item" }), 400);
  await tap(page, page.getByRole("group").getByRole("button", { name: "Single item" }), 300);
  await page.getByLabel("Name", { exact: true }).pressSequentially("Hedge trimmer", { delay: 45 });
  await page.getByLabel("Text (optional)").pressSequentially("sharpened in April", { delay: 35 });
  await tap(page, page.getByRole("button", { name: "Add", exact: true }), 300);
  await expect(page.getByRole("dialog")).toBeHidden();
  cam.mark("second");
  await page.waitForTimeout(1500);
  await cam.stop();

  // its look: a colour, then an icon
  await cam.start("t-style");
  await tap(page, page.getByRole("button", { name: "Drawer options" }), 500);
  await tap(page, page.getByTestId("drawer-icon"), 400);
  await tap(page, page.getByTestId("color-picker").getByRole("button", { name: "Olive" }), 500);
  await tap(page, page.getByTestId("icon-picker").getByRole("button", { name: "Tools" }), 600);
  await expect(page.getByRole("dialog")).toBeHidden();
  cam.mark("done");
  await page.waitForTimeout(1800);
  await cam.stop();

  // tags: one tag over items in three drawers, then the tag's own list
  await page.goto(`/drawers/${ids["documents"]}`);
  await expect(page.getByRole("heading", { name: D("documents") })).toBeVisible();
  await page.waitForTimeout(1200);
  const TAG = "travel";
  await cam.start("t-tags");
  await tap(page, page.getByRole("button", { name: "Manage tags" }), 600);
  await tap(page, page.getByRole("dialog").getByRole("button", { name: "New tag" }), 500);
  const tagSheet = page.getByRole("dialog").last();
  await tagSheet.getByLabel("Tag name").pressSequentially(TAG, { delay: 80 });
  for (const item of [uc("family.items.passports.name"), uc("trip.items.passes.name"), uc("cash.items.holiday.name")]) {
    const box = tagSheet.getByRole("checkbox", { name: item });
    await box.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await box.check();
  }
  await tap(page, tagSheet.getByRole("button", { name: "Save" }), 400);
  cam.mark("saved");
  await page.waitForTimeout(900);
  await tap(page, page.getByRole("dialog").last().getByRole("button", { name: new RegExp(TAG) }).first(), 300);
  cam.mark("detail");
  await page.waitForTimeout(1900);
  await cam.stop();

  // search: by tag, then by a word in a name
  await home(page);
  await cam.start("t-search");
  await tap(page, page.getByTestId("home-search-toggle"), 500);
  const search = page.getByTestId("home-search").locator("input");
  await search.pressSequentially(TAG, { delay: 120 });
  cam.mark("tag");
  await page.waitForTimeout(1800);
  await search.fill("");
  await search.pressSequentially("car key", { delay: 110 });
  cam.mark("word");
  await page.waitForTimeout(1800);
  await cam.stop();

  // sharing: invite Cara to the valuables as a reader, safety number compared
  await page.goto(`/drawers/${ids["valuables"]}/members`);
  await expect(page.getByRole("button", { name: "Invite someone" })).toBeVisible();
  await page.waitForTimeout(1000);
  await cam.start("t-share");
  await tap(page, page.getByRole("button", { name: "Invite someone" }), 600);
  await page.getByRole("dialog").getByLabel("Their email").pressSequentially(cara!.email, { delay: 40 });
  await tap(page, page.getByRole("dialog").getByRole("button", { name: "Find" }), 300);
  await expect(page.getByTestId("invite-found")).toBeVisible();
  cam.mark("found");
  await page.waitForTimeout(900);
  await tap(page, page.getByRole("radio", { name: /^Reader/ }), 300);
  await tap(page, page.getByRole("checkbox", { name: /I compared this safety number/ }), 600);
  await tap(page, page.getByTestId("invite-found").getByRole("button", { name: "Invite" }), 500);
  await expect(page.getByTestId("invite-found")).toBeHidden({ timeout: 15_000 });
  cam.mark("sent");
  await page.waitForTimeout(1600);
  await cam.stop();

  // Cara, on her own phone: compares the number, accepts, opens the drawer she may only read
  const cctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF, isMobile: true, hasTouch: true, colorScheme: "light" });
  await cctx.addInitScript(TOUCH_DOTS);
  const cp = await cctx.newPage();
  await loginAndUnlock(cp, cara!);
  await cp.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await expect(cp.getByRole("button", { name: "Accept" })).toBeVisible();
  await cp.waitForTimeout(1200);
  const ccam = new Camera(cp);
  await ccam.start("t-accept");
  await tap(cp, cp.getByRole("checkbox", { name: /I compared this number/ }), 900);
  await tap(cp, cp.getByRole("button", { name: "Accept" }), 600);
  await expect(cp.getByRole("button", { name: `Open ${D("valuables")}` })).toBeVisible({ timeout: 15_000 });
  ccam.mark("accepted");
  await cp.waitForTimeout(800);
  await tap(cp, cp.getByRole("button", { name: `Open ${D("valuables")}` }), 400);
  ccam.mark("drawer");
  await cp.waitForTimeout(2200);
  await ccam.stop();
  await cctx.close();

  // the look: another language, then dark; put back before the next clips (unfilmed)
  const pickOption = async (testId: string, value: string) => {
    const sel = page.getByTestId(testId);
    await sel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    // a native list does not show in the film: a tap dot where the finger would be, then the choice
    await sel.evaluate((el) => { const r = el.getBoundingClientRect(); dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); });
    await page.waitForTimeout(250);
    await sel.selectOption(value);
  };
  await page.goto("/settings");
  await expect(page.getByTestId("settings-language")).toBeVisible();
  await page.waitForTimeout(1000);
  await cam.start("t-settings");
  await pickOption("settings-language", "pl");
  cam.mark("language");
  await page.waitForTimeout(1600);
  await pickOption("settings-theme", "dark");
  cam.mark("dark");
  await page.waitForTimeout(1800);
  await cam.stop();
  await page.getByTestId("settings-language").selectOption("en");
  await page.getByTestId("settings-theme").selectOption("light");
  await page.waitForTimeout(800);

  // yours to keep: backup, install, passkeys
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Backup" })).toBeVisible();
  await placeAt(page, page.getByRole("heading", { name: "Access tokens" }), 90);
  await page.waitForTimeout(800);
  await cam.start("t-backup");
  await page.waitForTimeout(600);
  await glide(page, await page.getByRole("heading", { name: "Backup" }).evaluate((el) => el.getBoundingClientRect().top + scrollY - 90), 1500);
  cam.mark("backup");
  await page.waitForTimeout(1300);
  await glide(page, await page.getByRole("heading", { name: "Install the app" }).evaluate((el) => el.getBoundingClientRect().top + scrollY - 200), 1600);
  cam.mark("install");
  await page.waitForTimeout(1500);
  await cam.stop();

  // locked: the vault opens only with the passphrase (or a passkey) on this device
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(page.getByLabel("Vault passphrase")).toBeVisible();
  await page.waitForTimeout(1000);
  await cam.start("t-unlock");
  await page.waitForTimeout(900);
  await page.getByLabel("Vault passphrase").pressSequentially(ben!.passphrase, { delay: 35 });
  await tap(page, page.getByRole("button", { name: "Unlock" }), 300);
  await expect(page.getByTestId("home")).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  cam.mark("open");
  await page.waitForTimeout(2000);
  await cam.stop();

  // cash, last (it changes the checked tin): the tin, groceries, twenty out for bread on the keypad
  await page.goto(`/drawers/${ids["tin"]}`);
  await expect(page.getByRole("heading", { name: D("tin") })).toBeVisible();
  await page.waitForTimeout(1200);
  await cam.start("cash");
  await tap(page, row(uc("cash.items.groceries.name")), 700);
  await page.waitForTimeout(500);
  await tap(page, page.getByRole("button", { name: "Withdraw", exact: true }), 500);
  cam.mark("keypad");
  for (const d of "20") await tap(page, page.getByRole("group").getByRole("button", { name: d, exact: true }), 260);
  await page.waitForTimeout(250);
  await page.getByLabel("Comment (optional)").pressSequentially("bread", { delay: 90 });
  await tap(page, page.getByRole("button", { name: "Review" }), 350);
  await tap(page, page.getByRole("button", { name: "Save", exact: true }), 900);
  await expect(page.getByTestId("confirm-summary")).toBeHidden({ timeout: 15_000 });
  cam.mark("saved");
  await page.waitForTimeout(1800);
  await cam.stop();

  await ctx.close();
});

/**
 * The film's frame and words, each a full 1920×1080 picture the cutter lays over the clips: a
 * background per example (its drawers' colour), the phone, and the captions — the landing page's own
 * words. The phone's screen is at SCREEN; the cutter reads it from layout.json.
 */
const SCREEN = { x: 1180, y: 90, w: 416, h: 900 };
const INK = "#1c1a17", MUTED = "#5f5a50", BG = "#f5f3ef", GREEN = "#2f6f4f";
const TINT: Record<string, string> = { intro: GREEN, workshop: "#4f5a68", trip: "#1b7174", accounts: "#6c4a9e", cash: GREEN, lent: "#a4552f", family: "#a3406a", all: GREEN, ai: "#3657a6", outro: GREEN };
const STEPS = ["workshop", "trip", "accounts", "cash", "lent", "family", "all"];
/**
 * The feature tour's chapters (PETTY-325): the film's own words, English for now. Each names what its
 * clip shows; where the app already says it, its dictionary does.
 */
const TOUR: readonly { key: string; tint: string; chapter: string; title: string; body: () => string }[] = [
  { key: "core", tint: GREEN, chapter: "The idea", title: "Places, drawers, items", body: () => "A place is a room, a shelf or a box. A drawer sits in a place. Items are what is inside: money, things you count, and single things with a note." },
  { key: "nav", tint: "#1b7174", chapter: "Find your way", title: "Tap your way around", body: () => "The picture and the chips show your places: tap one to see only its drawers. The path on a drawer takes you back up." },
  { key: "places", tint: "#5d6a1e", chapter: "Places", title: "Arrange your places", body: () => w("places.manageHint") },
  { key: "drawer", tint: "#5d6a1e", chapter: "Drawers", title: "Add a drawer", body: () => "Give it a name and a place. A new place can be made right there." },
  { key: "items", tint: "#5d6a1e", chapter: "Items", title: "Fill it with items", body: () => "Money in any currency, things you count by the piece, and single things with a note." },
  { key: "style", tint: "#5d6a1e", chapter: "Drawers", title: "Give it a look", body: () => "A colour and an icon for each drawer, so you know it at a glance." },
  { key: "entries", tint: GREEN, chapter: "Money and counts", title: "Add and take out", body: () => "A few taps on the keypad and a note. You check it before it is saved, and every entry stays in the history." },
  { key: "check", tint: "#6c4a9e", chapter: "Checking", title: "Count, then mark as checked", body: () => w("landing.features.verify.body") },
  { key: "tags", tint: "#3657a6", chapter: "Tags", title: "One tag, many drawers", body: () => "Tag items wherever they are: travel, insurance, warranty. The tag lists them all." },
  { key: "search", tint: "#3657a6", chapter: "Search", title: "Search everything", body: () => "Names, notes and tags in every drawer. Each hit shows the place it is in." },
  { key: "share", tint: "#1b7174", chapter: "Sharing", title: "Share one drawer", body: () => "Invite someone by email, as a writer or a reader. Compare safety numbers once, and no one can quietly swap in their own key." },
  { key: "accept", tint: "#1b7174", chapter: "Sharing", title: "They accept on their phone", body: () => "Cara checks the number and accepts. As a reader she can see the drawer, not change it." },
  { key: "private", tint: "#4f5a68", chapter: "Privacy", title: "Locked on your device", body: () => "Names, amounts and notes are encrypted on your device. Your passkey or passphrase opens them; the server cannot." },
  { key: "settings", tint: "#4f5a68", chapter: "Settings", title: "Your language, your look", body: () => "English, polski, Deutsch, español, français. Light or dark. Hide what you do not use." },
  { key: "backup", tint: "#4f5a68", chapter: "Settings", title: "Yours to keep", body: () => "Export your drawers to a file, install Petty like an app, and keep working offline." },
];
const PIN = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>`;
const DRAWER = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`;
const KINDS = { money: "#2e7a4f", things: "#2f63a8", notes: "#9a5f12" };

const LOCK = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const CHAT = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function sheet(tint: string, body: string, opaque = false): string {
  const cx = SCREEN.x + SCREEN.w / 2, cy = SCREEN.y + SCREEN.h / 2;
  const ring = (r: number) => `<div class="ring" style="left:${cx - r}px;top:${cy - r}px;width:${2 * r}px;height:${2 * r}px"></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; background: ${opaque ? BG : "transparent"}; }
  body { --tint: ${tint}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: ${INK}; -webkit-font-smoothing: antialiased; position: relative; }
  .blob { position: absolute; border-radius: 50%; }
  .ring { position: absolute; border-radius: 50%; border: 2px dashed color-mix(in srgb, var(--tint) 20%, transparent); }
  .rings { position: absolute; inset: 0; mask-image: linear-gradient(to right, transparent 1000px, #000 1130px); }
  .col { position: absolute; left: 150px; top: 0; width: 880px; height: 1080px; display: flex; flex-direction: column; justify-content: center; }
  .eyebrow { display: inline-flex; align-items: center; gap: 14px; font-size: 25px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--tint); }
  .eyebrow i { width: 14px; height: 14px; border-radius: 50%; background: var(--tint); }
  .title { font-size: 92px; line-height: 1.02; font-weight: 800; letter-spacing: -0.03em; margin-top: 24px; text-wrap: balance; }
  .title.s { font-size: 80px; }
  .body { font-size: 35px; line-height: 1.42; color: ${MUTED}; margin-top: 30px; max-width: 820px; text-wrap: pretty; }
  .steps { display: flex; gap: 10px; margin-top: 48px; }
  .steps i { width: 46px; height: 7px; border-radius: 4px; background: #e0dbd2; }
  .steps i.on { background: var(--tint); }
  .steps.tour { gap: 8px; }
  .steps.tour i { width: 30px; height: 6px; }
  .concept { display: flex; align-items: center; gap: 18px; margin-top: 40px; font-size: 30px; font-weight: 700; }
  .concept span { display: inline-flex; align-items: center; gap: 12px; padding: 14px 24px; border-radius: 18px; background: #fff; border: 1px solid #e5e0d8; box-shadow: 0 10px 24px -14px rgba(60, 45, 25, .35); }
  .concept span svg { color: var(--tint); }
  .concept b { color: #b9b2a6; font-size: 34px; }
  .kinds { display: flex; gap: 26px; margin-top: 24px; font-size: 27px; color: ${MUTED}; }
  .kinds i { display: inline-block; width: 16px; height: 16px; border-radius: 50%; margin-right: 10px; vertical-align: -1px; }
  .brand { display: flex; align-items: center; gap: 28px; font-size: 104px; font-weight: 800; letter-spacing: -0.03em; }
  .brand img { width: 116px; height: 116px; border-radius: 28px; box-shadow: 0 18px 40px -16px rgba(31, 106, 69, .55); }
  .url { display: inline-block; align-self: flex-start; margin-top: 44px; padding: 22px 38px; border-radius: 999px; background: ${GREEN}; color: #fff; font-size: 40px; font-weight: 700; letter-spacing: -0.01em; box-shadow: 0 16px 36px -14px rgba(47, 111, 79, .6); }
  .phone { position: absolute; left: ${SCREEN.x - 14}px; top: ${SCREEN.y - 14}px; width: ${SCREEN.w + 28}px; height: ${SCREEN.h + 28}px; border: 14px solid #16181a; border-radius: 64px;
    box-shadow: 0 0 0 2px #45494d, 0 60px 110px -30px rgba(60, 45, 25, .45), 0 20px 40px -20px rgba(60, 45, 25, .35); }
  .card { margin-top: 44px; width: 820px; background: #fff; border: 1px solid #e5e0d8; border-radius: 30px; padding: 28px 34px 34px; box-shadow: 0 30px 60px -30px rgba(60, 45, 25, .35); }
  .card header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 20px; border-bottom: 1px solid #ece8e1; font-size: 25px; }
  .card header b { display: inline-flex; align-items: center; gap: 12px; }
  .card header span { display: inline-flex; align-items: center; gap: 8px; color: ${MUTED}; font-size: 22px; }
  .msgs { display: flex; flex-direction: column; gap: 20px; padding-top: 26px; font-size: 31px; line-height: 1.38; }
  .q { align-self: flex-end; background: ${GREEN}; color: #fff; padding: 16px 26px; border-radius: 28px 28px 8px 28px; }
  .tool { align-self: flex-start; display: inline-flex; align-items: center; gap: 10px; font-size: 22px; color: ${MUTED}; background: #f5f3ef; border: 1px solid #e5e0d8; border-radius: 999px; padding: 8px 18px; }
  .hide { visibility: hidden; }
  </style></head><body>${opaque ? `<div class="blob" style="left:${cx - 760}px;top:${cy - 760}px;width:1520px;height:1520px;background:radial-gradient(closest-side, color-mix(in srgb, var(--tint) 20%, transparent), transparent)"></div>
  <div class="blob" style="left:-420px;top:-520px;width:1200px;height:1200px;background:radial-gradient(closest-side, color-mix(in srgb, var(--tint) 9%, transparent), transparent)"></div><div class="rings">${ring(560)}${ring(770)}</div>` : ""}${body}</body></html>`;
}

test("draw the frame and the words", async ({ browser }) => {
  const dir = `${OUT}/layers`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const icon = `data:image/svg+xml;base64,${readFileSync(new URL("../public/app-icon.svg", import.meta.url)).toString("base64")}`;
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const shot = async (name: string, html: string, opaque = false) => {
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${dir}/${name}.png`, omitBackground: !opaque });
  };
  const steps = (key: string) => STEPS.includes(key) ? `<div class="steps">${STEPS.map((k) => `<i${k === key ? ' class="on"' : ""}></i>`).join("")}</div>` : "";

  for (const [key, tint] of Object.entries(TINT)) await shot(`bg-${key}`, sheet(tint, "", true), true);
  await shot("phone", sheet(GREEN, `<div class="phone"></div>`));
  for (const key of STEPS) {
    const eyebrow = `<div class="eyebrow"><i></i>${esc(uc(`${key}.chip`))}</div>`;
    await shot(`cap-${key}`, sheet(TINT[key]!, `<div class="col">${eyebrow}<div class="title">${esc(uc(`${key}.title`))}</div><div class="body">${esc(uc(`${key}.body`))}</div>${steps(key)}</div>`));
    await shot(`cap-${key}-short`, sheet(TINT[key]!, `<div class="col">${eyebrow}<div class="title s">${esc(uc(`${key}.title`))}</div>${steps(key)}</div>`));
  }
  // the tour: chapter, title, words, and where it is in the tour; the first chapter draws the idea itself
  const legend = (k: string) => esc(w(`landing.uses.legend.${k}`));
  const concept = `<div class="concept"><span>${PIN}${legend("place")}</span><b>›</b><span>${DRAWER}${legend("drawer")}</span><b>›</b><span>${legend("items")}</span></div>
    <div class="kinds">${(["money", "things", "notes"] as const).map((k) => `<span><i style="background:${KINDS[k]}"></i>${legend(k)}</span>`).join("")}</div>`;
  for (const [n, c] of TOUR.entries()) {
    const bars = `<div class="steps tour">${TOUR.map((_, i) => `<i${i === n ? ' class="on"' : ""}></i>`).join("")}</div>`;
    await shot(`cap-t-${c.key}`, sheet(c.tint, `<div class="col"><div class="eyebrow"><i></i>${esc(c.chapter)}</div><div class="title s">${esc(c.title)}</div><div class="body">${esc(c.body())}</div>${c.key === "core" ? concept : ""}${bars}</div>`));
  }
  for (const c of TOUR) await shot(`bg-t-${c.key}`, sheet(c.tint, "", true), true);
  const brand = `<div class="brand"><img src="${icon}" alt="">${esc(w("app.name"))}</div>`;
  const [keep, rest] = w("landing.tagline").split(" — ");
  await shot("cap-intro", sheet(GREEN, `<div class="col">${brand}<div class="title" style="margin-top:46px">${esc(w("landing.slogan"))}</div></div>`));
  await shot("cap-intro-short", sheet(GREEN, `<div class="col">${brand}<div class="title s" style="margin-top:46px">${esc(w("landing.slogan"))}</div></div>`));
  const url = process.env["PROMO_URL"] ?? "petty.kropka.studio";
  await shot("cap-outro", sheet(GREEN, `<div class="col">${brand}<div class="title s" style="margin-top:46px">${esc(keep!)}.</div><div class="body">${esc((rest ?? "").replace(/^./, (c) => c.toLocaleUpperCase(LOC)))}</div><div class="url">${esc(url)}</div></div>`));
  await shot("cap-outro-short", sheet(GREEN, `<div class="col">${brand}<div class="title s" style="margin-top:46px">${esc(keep!)}.</div><div class="url">${esc(url)}</div></div>`));
  // the AI scene: the heading and the card, then the question, the tool call and the answer one by one
  const chat = (show: string) => sheet(TINT["ai"]!, `<div class="col"><div class="eyebrow${show === "head" ? "" : " hide"}"><i></i>${esc(w("landing.ai.eyebrow"))}</div>
    <div class="title s${show === "head" ? "" : " hide"}">${esc(w("landing.ai.title"))}</div>
    <div class="card${show === "head" ? "" : " hide"}"><header><b>${CHAT}${esc(w("landing.ai.chat.app"))}</b><span>${LOCK}${esc(w("landing.ai.chat.local"))}</span></header>
      <div class="msgs"><div class="q${show === "q" ? "" : " hide"}">${esc(w("landing.ai.chat.q1"))}</div><div class="tool${show === "tool" ? "" : " hide"}">${LOCK}${esc(w("landing.ai.chat.tool1"))}</div><div class="${show === "a" ? "" : "hide"}">${esc(w("landing.ai.chat.a1"))}</div></div></div></div>`)
    // a hidden card hides its children too: show the one asked for inside it
    .replace(/class="card hide"/, `class="card" style="background:transparent;border-color:transparent;box-shadow:none"`).replace(/<header>/, show === "head" ? "<header>" : `<header style="visibility:hidden">`);
  for (const part of ["head", "q", "tool", "a"]) await shot(`ai-${part}`, chat(part));
  writeFileSync(`${dir}/layout.json`, JSON.stringify({ width: 1920, height: 1080, screen: SCREEN }));
  await ctx.close();
});
