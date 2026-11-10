import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dbQuery, expect, loginAndUnlock, signupWithKeys, test } from "./fixtures.js";

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
  // PETTY-451: 20 letters in five groups
  await expect.poll(login.err, { timeout: 30_000 }).toMatch(/\/device\?code=[A-Z]{4}(-[A-Z]{4}){4}\s/);
  return { url: /(http\S+\/device\?code=[A-Z-]+)/.exec(login.err())![1]!, code: /code: ([A-Z]{4}(?:-[A-Z]{4}){4})\n/.exec(login.err())![1]! };
}

test("petty auth login: allowed on the /device page for one drawer, the command line reads that drawer only", async ({ page }) => {
  const origin = test.info().project.use.baseURL!;
  const user = await signupWithKeys("cli");
  await loginAndUnlock(page, user);
  for (const name of ["Kitchen tin", "Attic box"]) {
    await page.goto("/");
    await page.getByRole("button", { name: "Add drawer" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  const atticId = /\/drawers\/([0-9a-f-]+)/.exec(page.url())![1]!;

  const dir = configDir();
  const login = petty(["auth", "login", "--host", origin, "--no-browser"], dir);
  const { url, code } = await asked(login);
  expect(url).toBe(`${origin}/device?code=${code}`);
  await page.goto(url);
  // the page shows what asks, and the same code as the terminal
  await expect(page.getByTestId("device-ask")).toContainText(`Allow “petty on`);
  await expect(page.getByTestId("device-shown-code")).toHaveText(code);
  // PETTY-452: no drawers are chosen for the person, and nothing is made until they choose
  const ask = page.getByTestId("device-ask");
  await expect(page.getByTestId("device-scope-all")).not.toBeChecked();
  await expect(page.getByTestId("device-scope-some")).not.toBeChecked();
  await page.getByTestId("device-allow").click();
  await expect(ask.getByRole("alert")).toHaveText("Choose which drawers this token can use.");
  // all of it works from the keyboard: the radios are one group, the drawers are checkboxes
  await page.getByTestId("device-scope-all").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("device-scope-some")).toBeChecked();
  await page.getByTestId("device-allow").click();
  await expect(ask.getByRole("alert")).toHaveText("Choose which drawers this token can use."); // none picked yet
  const drawers = page.getByRole("group", { name: "Drawers for this token" });
  await expect(drawers.getByRole("checkbox")).toHaveCount(2);
  await drawers.getByRole("checkbox", { name: "Kitchen tin" }).focus();
  await page.keyboard.press("Space");
  await expect(drawers.getByRole("checkbox", { name: "Kitchen tin" })).toBeChecked();
  // the vault confirms every token: nothing typed, or the wrong passphrase, makes none
  await page.getByTestId("device-allow").click();
  await expect(ask.getByRole("alert")).toHaveText("Enter your vault passphrase.");
  await page.getByTestId("device-passphrase").fill("not the passphrase at all");
  await page.getByTestId("device-allow").click();
  await expect(ask.getByRole("alert")).toHaveText("That passphrase did not open the vault.");
  expect(await dbQuery("select 1 from access_tokens t join users u on u.id = t.user_id where u.email = $1", [user.email])).toHaveLength(0);
  await page.getByTestId("device-passphrase").fill(user.passphrase);
  await page.getByTestId("device-allow").click();
  await expect(page.getByTestId("device-done")).toBeVisible();
  expect(await login.done).toBe(0);
  expect(login.err()).toContain(`Signed in to ${origin}`);

  const list = petty(["drawers", "--json"], dir);
  expect(await list.done).toBe(0);
  expect((JSON.parse(list.out()) as { name: string }[]).map((d) => d.name)).toEqual(["Kitchen tin"]);
  // a drawer outside the token's drawers: the command line says what it cannot do, and why
  const byName = petty(["move", "Attic box", "Home"], dir);
  expect(await byName.done).toBe(4);
  expect(byName.err()).toContain("(this token opens only the 1 drawer chosen for it)");
  const byId = petty(["history", `${atticId}/${crypto.randomUUID()}`], dir);
  expect(await byId.done).toBe(4);
  expect(byId.err()).toContain("(this token opens only the 1 drawer chosen for it)");

  // an ordinary access token: Settings lists it with what it may use, and it can be revoked there
  await page.goto("/settings");
  await expect(page.getByTestId("token-row").filter({ hasText: "petty on" })).toContainText("1 drawer");
  const [row] = (await dbQuery("select t.scope, t.expires_at from access_tokens t join users u on u.id = t.user_id where u.email = $1", [user.email])) as { scope: string[] | null; expires_at: Date | null }[];
  expect(row!.scope).toHaveLength(1);
  expect(row!.scope).not.toContain(atticId);
  // an end date unless the person chose none: 90 days is what the command line asks for
  expect(Math.round((row!.expires_at!.getTime() - Date.now()) / 86_400_000)).toBe(90);
});

test("Deny on the /device page: the command line stops and is not signed in", async ({ page }) => {
  const origin = test.info().project.use.baseURL!;
  const user = await signupWithKeys("cld");
  await loginAndUnlock(page, user);
  const login = petty(["auth", "login", "--host", origin, "--no-browser", "--read-only"], configDir());
  const { url } = await asked(login);
  await page.goto(url);
  await expect(page.getByText("It asks to read only. It cannot change anything.")).toBeVisible();
  await page.getByTestId("device-deny").click();
  await expect(page.getByTestId("device-denied")).toBeVisible();
  expect(await login.done).toBe(3);
  expect(login.err()).toContain("denied on the page");
  // PETTY-279: not a dead end
  await page.getByTestId("device-denied").getByRole("link", { name: "Done" }).click();
  await expect(page.getByTestId("drawers-header").or(page.getByTestId("home-empty"))).toBeVisible();
});

test("signed out, the /device link leads through sign-in and unlock back to the request", async ({ page }) => {
  const origin = test.info().project.use.baseURL!;
  const user = await signupWithKeys("clr");
  const login = petty(["auth", "login", "--host", origin, "--no-browser", "--read-only"], configDir());
  const { url, code } = await asked(login);
  await page.goto(url);
  await expect(page).toHaveURL(/\/login$/);
  // PETTY-281 (F15): the sign-in page says why it is there
  await expect(page.getByTestId("login-after-device")).toHaveText("Sign in to allow the command-line tool that is waiting in your terminal.");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(`${origin}/device?code=${code}`);
  await expect(page.getByTestId("device-shown-code")).toHaveText(code);
  // PETTY-452: a token that only reads is confirmed by the vault too, and "all drawers" is a choice
  await page.getByTestId("device-scope-all").check();
  await page.getByTestId("device-allow").click();
  await expect(page.getByTestId("device-ask").getByRole("alert")).toHaveText("Enter your vault passphrase.");
  await page.getByTestId("device-passphrase").fill(user.passphrase);
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
  // PETTY-451: a code of the earlier 12-letter form is not a code any more
  await page.getByTestId("device-code").fill("bcdf ghjk lmnp");
  await page.getByTestId("device-continue").click();
  await expect(page.getByRole("alert")).toContainText("That is not a code. A code has 20 letters");
  await page.goto("/device?code=BCDF-GHJK-LMNP");
  await expect(page.getByTestId("device-code")).toHaveValue("BCDF-GHJK-LMNP");
  await expect(page.getByTestId("device-ask")).toHaveCount(0);
  await page.getByTestId("device-code").fill("bcdf ghjk lmnp qrst vwxz");
  await page.getByTestId("device-continue").click();
  await expect(page.getByRole("alert")).toContainText("No request is waiting with this code");
});

test("a request whose key is not the one its code was made from cannot be allowed (PETTY-451)", async ({ page }) => {
  const origin = test.info().project.use.baseURL!;
  const user = await signupWithKeys("clk");
  await loginAndUnlock(page, user);
  const login = petty(["auth", "login", "--host", origin, "--no-browser", "--read-only"], configDir());
  try {
    const { url, code } = await asked(login);
    // the row now holds another key than the command line's
    const other = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const otherPub = Buffer.from(await crypto.subtle.exportKey("spki", other.publicKey)).toString("base64");
    expect(await dbQuery("update device_requests set cli_pub = $1 where user_code = $2 returning id", [otherPub, code])).toHaveLength(1);
    await page.goto(url);
    await expect(page.getByTestId("device-mismatch")).toContainText("This request does not match its code.");
    await expect(page.getByTestId("device-mismatch")).toContainText(`petty auth login --host ${origin}`);
    await expect(page.getByTestId("device-allow")).toHaveCount(0);
    expect(await dbQuery("select 1 from access_tokens t join users u on u.id = t.user_id where u.email = $1", [user.email])).toHaveLength(0);
  } finally { login.stop(); }
});
