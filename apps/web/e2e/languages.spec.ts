import { readFileSync } from "node:fs";
import { apiClient, expect, loginAndUnlock, openSettings, signupWithKeys, test } from "./fixtures.js";

/** PETTY-249: five languages, one switch on every signed-out page, the choice kept on the device and the account. */
const LOCALES = ["en", "pl", "de", "es", "fr"] as const;
type Dict = { landing: { tagline: string; uses: { title: string } }; auth: { login: { title: string } } };
const dict = (l: string): Dict => JSON.parse(readFileSync(new URL(`../src/i18n/${l}.json`, import.meta.url), "utf8")) as Dict;

test("the landing page switches between all five languages from the top, keeps the choice, and shows its screenshots in each", async ({ page }) => {
  await page.goto("/");
  for (const l of LOCALES) {
    await page.getByTestId("landing-language").selectOption(l);
    const d = dict(l);
    await expect(page.locator("html")).toHaveAttribute("lang", l);
    await expect(page.locator(".landing-tag")).toHaveText(d.landing.tagline);
    await expect(page.getByRole("heading", { name: d.landing.uses.title })).toBeVisible();
    await expect(page.locator(".shots img").first()).toHaveAttribute("src", `/landing/home-${l}-light.webp`);
    // the footer lists the same languages, each in its own name
    for (const name of ["English", "Polski", "Deutsch", "Español", "Français"]) await expect(page.locator(".landing-footer").getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.getByTestId("landing-language").selectOption("es");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.locator(".landing-tag")).toHaveText(dict("es").landing.tagline);
  for (const l of LOCALES) for (const theme of ["light", "dark"]) expect((await page.request.get(`/landing/home-${l}-${theme}.webp`)).status(), `${l} ${theme}`).toBe(200);
});

test("a first visit follows the browser's language, and falls back to English", async ({ browser }) => {
  for (const [browserLocale, l] of [["fr-FR", "fr"], ["de-AT", "de"], ["es-MX", "es"], ["pl-PL", "pl"], ["it-IT", "en"]] as const) {
    const ctx = await browser.newContext({ locale: browserLocale });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator("html"), browserLocale).toHaveAttribute("lang", l);
    await expect(page.locator(".landing-tag")).toHaveText(dict(l).landing.tagline);
    await ctx.close();
  }
});

test("every signed-out page has the switch; signed in, Settings keeps the language on the account", async ({ page }) => {
  for (const path of ["/login", "/privacy", "/ai"]) {
    await page.goto(path);
    await expect(page.getByTestId("language-picker"), path).toBeVisible();
  }
  await page.goto("/login");
  await page.getByTestId("language-picker").selectOption("de");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(dict("de").auth.login.title);
  await page.getByTestId("language-picker").selectOption("en");
  const user = await signupWithKeys("lang");
  await loginAndUnlock(page, user);
  await expect(page.getByTestId("language-picker")).toHaveCount(0); // signed in: the switch lives in Settings
  await openSettings(page);
  await page.getByTestId("settings-language").selectOption("fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  const api = await apiClient(user);
  await expect.poll(async () => ((await api.call("GET", "/me")).json as { locale: string }).locale).toBe("fr"); // emails follow it
});
