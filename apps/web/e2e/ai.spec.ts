import { expect, loginAndUnlock, openSettings, signupViaApi, test } from "./fixtures.js";

/** PETTY-173: the "Use Petty with AI" page, public, with this Petty's address filled in. */
test("the AI page explains the setup with this Petty's own address, and is linked from the landing page and Settings", async ({ page, baseURL }) => {
  await page.goto("/");
  await page.getByTestId("landing-ai").click();
  await expect(page.getByRole("heading", { name: "Use Petty with AI" })).toBeVisible();
  const api = `${new URL(baseURL!).origin}/api`;
  await expect(page.getByTestId("ai-address")).toHaveValue(api);
  const config = JSON.parse(await page.getByTestId("ai-config").innerText()) as { mcpServers: { petty: { env: Record<string, string> } } };
  expect(config.mcpServers.petty.env).toEqual({ PETTY_TOKEN: "petty_pat_…", PETTY_API_URL: api }); // never a real token
  await expect(page.getByTestId("ai-tools").locator("li")).toHaveCount(13);
  await expect(page.getByTestId("ai-source")).toHaveAttribute("href", "https://github.com/WawRepo/petty");
  expect((await page.request.get("/downloads/petty-mcp.mjs")).status()).toBe(200);

  const user = await signupViaApi("aipage");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await openSettings(page);
  await page.getByTestId("tokens-ai-link").click();
  await expect(page).toHaveURL(/\/ai$/);
  await expect(page.getByRole("heading", { name: "Use Petty with AI" })).toBeVisible();
});
