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
  await expect(page.getByTestId("ai-tools").locator("li")).toHaveCount(16);
  await expect(page.getByTestId("ai-source")).toHaveAttribute("href", "https://github.com/WawRepo/petty");
  expect((await page.request.get("/downloads/petty-mcp.mjs")).status()).toBe(200);
  // PETTY-418: a dev build is no release, so the files are this Petty's own copies, and the page says
  // plainly that nothing checks them
  await expect(page.getByTestId("ai-files-own")).toContainText("This Petty runs a build that is not a published release (dev)");
  await expect(page.getByTestId("ai-files")).toContainText("Nothing checks these files.");
  await expect(page.getByTestId("ai-verify")).toHaveCount(0);
  await expect(page.getByTestId("ai-addon")).toHaveAttribute("href", "/downloads/petty.mcpb");
  // PETTY-454: the command line comes before the by-hand way, and no command on the page takes a token
  const order = await page.evaluate(() => [...document.querySelectorAll("main section[data-testid]")].map((s) => s.getAttribute("data-testid")));
  expect(order).toEqual(["ai-files", "ai-desktop", "ai-cli", "ai-other"]);
  await expect(page.getByTestId("ai-cli-other")).toContainText("petty mcp --print-config");
  await expect(page.getByTestId("ai-claude-code")).toContainText("Do not put a token into a claude mcp add command");
  for (const block of await page.locator("pre.codeblock").allInnerTexts()) expect(block).not.toMatch(/PETTY_TOKEN=|petty_pat_[^…]/);

  const user = await signupViaApi("aipage");
  await loginAndUnlock(page, user);
  await page.getByTestId("passkey-nudge").getByRole("button", { name: "Not now" }).click().catch(() => undefined);
  await openSettings(page);
  await page.getByTestId("tokens-ai-link").click();
  await expect(page).toHaveURL(/\/ai$/);
  await expect(page.getByRole("heading", { name: "Use Petty with AI" })).toBeVisible();
});

// PETTY-418: the programs run on the person's computer with their token, so a Petty that runs a release
// sends people to that version's GitHub release, where a file can be checked, not to its own copies.
test("a Petty that runs a release takes the programs from that version's GitHub release and shows how to check them", async ({ page, baseURL }) => {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), version: "v1.2.3" } });
  });
  const origin = new URL(baseURL!).origin;
  const release = "https://github.com/WawRepo/petty/releases/download/v1.2.3";
  const check = (path: string) => `gh attestation verify ${path} --repo WawRepo/petty --signer-workflow WawRepo/petty/.github/workflows/release.yml --source-ref refs/heads/main`;
  await page.goto("/ai");
  await expect(page.getByTestId("ai-files")).toContainText("from the GitHub release of the version this Petty runs (v1.2.3), not from this Petty");
  await expect(page.getByTestId("ai-files")).toContainText("This Petty also serves its own copies under /downloads/. Nothing checks those.");
  await expect(page.getByTestId("ai-files")).toContainText("they should begin with https://github.com/WawRepo/petty/");
  await expect(page.getByTestId("ai-files-own")).toHaveCount(0);
  await expect(page.getByTestId("ai-verify")).toHaveText([check("~/Downloads/petty.mcpb"), check("~/.petty/petty-mcp.mjs"), check("~/.local/bin/petty")].join("\n"));
  await expect(page.getByTestId("ai-sums")).toHaveAttribute("href", `${release}/SHA256SUMS`);
  await expect(page.getByTestId("ai-verify-docs")).toHaveAttribute("href", "https://github.com/WawRepo/petty/blob/v1.2.3/docs/cli.md#check-what-you-download");
  // every button and command: the release's file; the address to sign in to stays this Petty's
  await expect(page.getByTestId("ai-addon")).toHaveAttribute("href", `${release}/petty.mcpb`);
  await expect(page.getByRole("link", { name: "Download petty-mcp.mjs" })).toHaveAttribute("href", `${release}/petty-mcp.mjs`);
  await expect(page.getByRole("link", { name: "Download petty.mjs" })).toHaveAttribute("href", `${release}/petty.mjs`);
  await expect(page.getByTestId("ai-install-unix")).toHaveText(`mkdir -p ~/.petty && curl -fsSL ${release}/petty-mcp.mjs -o ~/.petty/petty-mcp.mjs\nnode ~/.petty/petty-mcp.mjs --print-config ${origin}/api`);
  await expect(page.getByTestId("ai-install-windows")).toContainText(`Invoke-WebRequest ${release}/petty-mcp.mjs -OutFile`);
  await expect(page.getByTestId("ai-cli-unix")).toHaveText(`mkdir -p ~/.local/bin && curl -fsSL ${release}/petty.mjs -o ~/.local/bin/petty && chmod +x ~/.local/bin/petty\n~/.local/bin/petty auth login --host ${origin}`);
  await expect(page.getByTestId("ai-cli-windows")).toContainText(`Invoke-WebRequest ${release}/petty.mjs -OutFile`);
  for (const block of await page.locator("pre.codeblock").allInnerTexts()) expect(block).not.toContain("/downloads/");

  // the short setup on the landing page: the same source, and where the checks are described
  await page.goto("/");
  await expect(page.getByTestId("ai-mcpb")).toHaveAttribute("href", `${release}/petty.mcpb`);
  await expect(page.getByTestId("ai-files-from")).toHaveText("The files come from the GitHub release of this version (v1.2.3). Use Petty with AI below says how to check them.");
  await page.getByTestId("ai-app-code").click();
  await expect(page.getByTestId("ai-command")).toContainText(`curl -fsSL ${release}/petty.mjs -o ~/.local/bin/petty`);
  await expect(page.getByTestId("ai-command")).toContainText(`~/.local/bin/petty auth login --host ${origin}`);
  await page.getByTestId("ai-app-cursor").click();
  await expect(page.getByTestId("ai-command")).toHaveText(`mkdir -p ~/.petty && curl -fsSL ${release}/petty-mcp.mjs -o ~/.petty/petty-mcp.mjs\nnode ~/.petty/petty-mcp.mjs --print-config ${origin}/api`);
  await page.getByTestId("ai-app-any").click();
  await expect(page.getByTestId("ai-files-from")).toHaveCount(0);
});

test("a Petty whose version is no release offers its own copies and says nothing checks them", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), version: "v1.2.3-ours.4" } });
  });
  await page.goto("/ai");
  await expect(page.getByTestId("ai-files-own")).toContainText("This Petty runs a build that is not a published release (v1.2.3-ours.4), so the buttons and commands on this page take them from this Petty itself.");
  await expect(page.getByTestId("ai-files")).toContainText("Nothing checks these files. Use them only if you trust whoever runs this Petty");
  await expect(page.getByTestId("ai-addon")).toHaveAttribute("href", "/downloads/petty.mcpb");
  await expect(page.getByTestId("ai-cli-unix")).toContainText("/downloads/petty.mjs -o ~/.local/bin/petty");
  await page.goto("/");
  await expect(page.getByTestId("ai-files-from")).toHaveText("The files come from this Petty itself, and nothing checks them. Use Petty with AI below says more.");
  await expect(page.getByTestId("ai-mcpb")).toHaveAttribute("href", "/downloads/petty.mcpb");
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
