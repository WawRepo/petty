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
  // PETTY-333: and Claude Code adds petty by its full path, for every project
  await expect(page.getByTestId("ai-cli-claude")).toHaveText("claude mcp add -s user petty -- ~/.local/bin/petty mcp");
  await expect(page.getByTestId("ai-tools").locator("li")).toHaveCount(14);
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

test("Settings shows a signed-in person the same AI setup, with this Petty's address (PETTY-333)", async ({ page, baseURL }) => {
  const user = await signupViaApi("aiset");
  await loginAndUnlock(page, user);
  await openSettings(page);
  const origin = new URL(baseURL!).origin;
  const section = page.getByTestId("ai-section");
  await expect(section.getByRole("heading", { name: "Use Petty in your AI app" })).toBeVisible();
  await expect(section.getByRole("group", { name: "Use Petty in your AI app" }).getByRole("button")).toHaveCount(6);
  await expect(section.getByTestId("ai-command")).toHaveText(`${origin}/api`);
  await expect(section.getByTestId("ai-mcpb")).toHaveAttribute("href", "/downloads/petty.mcpb");
  await section.getByTestId("ai-app-code").click();
  await expect(section.getByTestId("ai-command")).toContainText(`~/.local/bin/petty auth login --host ${origin}`);
  await expect(section.getByTestId("ai-command")).toContainText("claude mcp add -s user petty -- ~/.local/bin/petty mcp");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await section.getByTestId("ai-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`curl -fsSL ${origin}/downloads/petty.mjs`);
});
