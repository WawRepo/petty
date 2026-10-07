import { expect, makeJoinLink, test } from "./fixtures.js";

/**
 * PETTY-342: a deployment's own privacy notice and terms (LEGAL_DIR on the server). The dev server has
 * none, which is also checked; the deployment that has them is played by answering /config and /legal here.
 */
const PRIVACY: Record<string, string> = {
  en: "# Privacy notice\n\n**Controller:** Example Operator, [write](mailto:op@example.test).\n\n## Your rights\n- access\n- erasure\n",
  pl: "# Polityka prywatności\n\n**Administrator:** Example Operator.\n",
};
const TERMS = "# Terms\n\nRead the [privacy notice](/privacy).\n\n[evil](javascript:alert(1)) <script>window.hacked = true</script>\n";

async function asOperator(page: import("@playwright/test").Page) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), legal: { privacy: true, terms: true } } });
  });
  await page.route("**/api/legal/**", async (route) => {
    const url = new URL(route.request().url());
    const lang = url.searchParams.get("lang") ?? "en";
    const doc = url.pathname.endsWith("/terms") ? "terms" : "privacy";
    const text = doc === "terms" ? TERMS : PRIVACY[lang] ?? PRIVACY["en"]!;
    await route.fulfill({ json: { doc, lang: PRIVACY[lang] || doc === "terms" ? lang : "en", text } });
  });
}

test("without texts nothing new shows: no terms link, the terms page says there are none, sign-up names the privacy page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("landing-terms")).toHaveCount(0);
  await page.goto("/terms");
  await expect(page.getByTestId("terms-none")).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByTestId("legal-privacy")).toHaveCount(0);
  await page.goto(`/join#${await makeJoinLink()}`);
  const legal = page.getByTestId("signup-legal");
  await expect(legal).toContainText("The privacy notice says what data is kept and why.");
  await expect(legal).not.toContainText("terms of service");
  await expect(legal.getByRole("button", { name: "Privacy and security" })).toBeVisible();
});

test("an operator's terms and privacy notice: linked from the landing page and sign-up, shown as text, never as HTML", async ({ page }) => {
  await asOperator(page);
  await page.goto("/");
  await page.getByTestId("landing-terms").click();
  await expect(page).toHaveURL(/\/terms$/);
  const terms = page.getByTestId("legal-terms");
  await expect(terms.getByRole("heading", { name: "Terms" })).toBeVisible();
  // a script link and raw HTML stay text
  await expect(terms.getByRole("link", { name: "evil" })).toHaveCount(0);
  await expect(terms).toContainText("<script>window.hacked = true</script>");
  expect(await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked)).toBeUndefined();
  // a link to a page of the app stays in the app
  await terms.getByRole("link", { name: "privacy notice" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  const notice = page.getByTestId("legal-privacy");
  await expect(notice.getByRole("heading", { name: "Your rights" })).toBeVisible();
  await expect(notice.getByRole("link", { name: "write" })).toHaveAttribute("href", "mailto:op@example.test");
  await expect(notice.locator("li")).toHaveText(["access", "erasure"]);

  await page.goto(`/join#${await makeJoinLink()}`);
  const legal = page.getByTestId("signup-legal");
  await expect(legal).toContainText("By creating an account, you accept the terms of service.");
  await legal.getByRole("button", { name: "Terms of service" }).click();
  await expect(page).toHaveURL(/\/terms$/);
});

test("the privacy notice comes in the language on screen when the operator wrote it", async ({ page }) => {
  await asOperator(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Polski" }).click();
  await page.goto("/privacy");
  await expect(page.getByTestId("legal-privacy").getByRole("heading", { name: "Polityka prywatności" })).toBeVisible();
});
