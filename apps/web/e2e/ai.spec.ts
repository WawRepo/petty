import { expect, loginAndUnlock, openSettings, signupViaApi, test } from "./fixtures.js";

/** PETTY-173: the "Use Petty with AI" page, public, with this Petty's address filled in. */
test("the AI page explains the setup with this Petty's own address, and is linked from the landing page and Settings", async ({ page, baseURL }) => {
  await page.goto("/");
  // MF2 (AGPL section 13): the source link is offered on the landing footer and the privacy page
  await expect(page.getByTestId("landing-source")).toHaveAttribute("href", "https://github.com/WawRepo/petty");
  await page.goto("/privacy");
  await expect(page.getByTestId("privacy-source")).toHaveAttribute("href", "https://github.com/WawRepo/petty");
  await page.goto("/");
  await page.getByTestId("landing-ai").click();
  await expect(page.getByRole("heading", { name: "Use Petty with AI" })).toBeVisible();
  const api = `${new URL(baseURL!).origin}/api`;
  await expect(page.getByTestId("ai-address")).toHaveValue(api);
  const config = JSON.parse(await page.getByTestId("ai-config").innerText()) as { mcpServers: { petty: { env: Record<string, string> } } };
  expect(config.mcpServers.petty.env).toEqual({ PETTY_TOKEN: "petty_pat_…", PETTY_API_URL: api }); // never a real token
  // the easy install: one copyable command per OS, downloading from THIS Petty into ~/.petty, then --print-config
  const origin = new URL(baseURL!).origin;
  await expect(page.getByTestId("ai-install-unix")).toContainText(`curl -fsSL ${origin}/downloads/petty-mcp.mjs -o ~/.petty/petty-mcp.mjs`);
  await expect(page.getByTestId("ai-install-unix")).toContainText(`--print-config ${api}`);
  await expect(page.getByTestId("ai-install-windows")).toContainText(`Invoke-WebRequest ${origin}/downloads/petty-mcp.mjs`);
  // PETTY-279: the example block has made-up paths, so it has no copy button (S13); and the command line's
  // first run names its file, since ~/.local/bin is not on a Mac's PATH, and says how to add it (S12)
  await expect(page.getByRole("button", { name: "Copy the settings block" })).toHaveCount(0);
  await expect(page.getByTestId("ai-cli-unix")).toContainText(`~/.local/bin/petty auth login --host ${origin}`);
  await expect(page.getByTestId("ai-cli-path")).toContainText('export PATH="$HOME/.local/bin:$PATH"');
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
