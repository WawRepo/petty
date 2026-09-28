import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, loginAndUnlock, signupWithKeys, test } from "./fixtures.js";

/**
 * PETTY-274: `petty auth login` signs the command line in through the web app's /device page, the way
 * `gh auth login` works. The real CLI runs here as a child process against the dev server; the person
 * reads its code, allows it on the page (the page makes an access token and seals it to the CLI's key),
 * and the CLI then reads the drawers with it.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
test.afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function petty(args: string[], dir: string) {
  const child = spawn(join(ROOT, "apps/cli/node_modules/.bin/tsx"), [join(ROOT, "apps/cli/src/bin.ts"), ...args], {
    env: { ...process.env, PETTY_CONFIG_DIR: dir, PETTY_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const done = new Promise<number>((r) => child.on("close", (code) => r(code ?? -1)));
  return { done, out: () => out, err: () => err, stop: () => child.kill() };
}
const configDir = () => { const d = mkdtempSync(join(tmpdir(), "petty-e2e-")); dirs.push(d); return d; };
/** What `petty auth login` printed: its code and the page to open. */
async function asked(login: ReturnType<typeof petty>) {
  await expect.poll(login.err, { timeout: 30_000 }).toMatch(/\/device\?code=[A-Z]{4}-[A-Z]{4}-[A-Z]{4}/);
  return { url: /(http\S+\/device\?code=[A-Z-]+)/.exec(login.err())![1]!, code: /code: ([A-Z]{4}-[A-Z]{4}-[A-Z]{4})/.exec(login.err())![1]! };
}

test("petty auth login: allowed on the /device page, the command line reads the drawers", async ({ page }) => {
  const origin = test.info().project.use.baseURL!;
  const user = await signupWithKeys("cli");
  await loginAndUnlock(page, user);
  await page.getByRole("button", { name: "Add drawer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Kitchen tin");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen tin" })).toBeVisible();

  const dir = configDir();
  const login = petty(["auth", "login", "--host", origin, "--no-browser"], dir);
  const { url, code } = await asked(login);
  expect(url).toBe(`${origin}/device?code=${code}`);
  await page.goto(url);
  // the page shows what asks, and the same code as the terminal
  await expect(page.getByTestId("device-ask")).toContainText(`Allow “petty on`);
  await expect(page.getByTestId("device-shown-code")).toHaveText(code);
  await page.getByTestId("device-passphrase").fill(user.passphrase); // it may add entries: the vault confirms
  await page.getByTestId("device-allow").click();
  await expect(page.getByTestId("device-done")).toBeVisible();
  expect(await login.done).toBe(0);
  expect(login.err()).toContain(`Signed in to ${origin}`);

  const list = petty(["drawers", "--json"], dir);
  expect(await list.done).toBe(0);
  expect((JSON.parse(list.out()) as { name: string }[]).map((d) => d.name)).toContain("Kitchen tin");

  // an ordinary access token: Settings lists it, and it can be revoked there
  await page.goto("/settings");
  await expect(page.getByTestId("token-row").filter({ hasText: "petty on" })).toBeVisible();
});

test("Deny on the /device page: the command line stops and is not signed in", async ({ page }) => {
  const origin = test.info().project.use.baseURL!;
  const user = await signupWithKeys("cld");
  await loginAndUnlock(page, user);
  const login = petty(["auth", "login", "--host", origin, "--no-browser", "--read-only"], configDir());
  const { url } = await asked(login);
  await page.goto(url);
  await expect(page.getByText("It asks to read only. It cannot add entries.")).toBeVisible();
  await page.getByTestId("device-deny").click();
  await expect(page.getByTestId("device-denied")).toBeVisible();
  expect(await login.done).toBe(3);
  expect(login.err()).toContain("denied on the page");
});

test("signed out, the /device link leads through sign-in and unlock back to the request", async ({ page }) => {
  const origin = test.info().project.use.baseURL!;
  const user = await signupWithKeys("clr");
  const login = petty(["auth", "login", "--host", origin, "--no-browser", "--read-only"], configDir());
  const { url, code } = await asked(login);
  await page.goto(url);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(`${origin}/device?code=${code}`);
  await expect(page.getByTestId("device-shown-code")).toHaveText(code);
  await page.getByTestId("device-allow").click();
  await expect(page.getByTestId("device-done")).toBeVisible();
  expect(await login.done).toBe(0);
  expect(login.err()).toContain("(read only)");
});

test("a typed code that no request has, and one that is not a code, are refused on the page", async ({ page }) => {
  const user = await signupWithKeys("clc");
  await loginAndUnlock(page, user);
  await page.goto("/device");
  await page.getByTestId("device-code").fill("hello");
  await page.getByTestId("device-continue").click();
  await expect(page.getByRole("alert")).toContainText("That is not a code");
  await page.getByTestId("device-code").fill("bcdf ghjk lmnp");
  await page.getByTestId("device-continue").click();
  await expect(page.getByRole("alert")).toContainText("No request is waiting with this code");
});
