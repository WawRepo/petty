import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { expect, loginAndUnlock, makeJoinLink, signupViaApi, test, openSettings, choosePassphraseDoor } from "./fixtures.js";

const OWNER_DB = process.env["DATABASE_URL"] ?? "postgres://petty:petty@localhost:5432/petty";
import type { Page } from "@playwright/test";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
}

test("signup through a join link, save the recovery code, land on an empty drawer list; stays unlocked across reload", async ({ page }) => {
  const token = await makeJoinLink();
  await page.goto(`/join#${token}`);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await axe(page);
  const run = Math.random().toString(36).slice(2, 8);
  await page.getByLabel("Your name").fill("Dana");
  await page.getByLabel("Email").fill(`dana-${run}@e2e.local`);
  await page.getByLabel("Login password").fill(`login-${run}-pw`);
  await choosePassphraseDoor(page);
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`login-${run}-pw`); // same as password → refused
  await page.getByLabel("Repeat the vault passphrase").fill(`login-${run}-pw`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toContainText("must differ");
  await page.getByLabel("Vault passphrase", { exact: true }).fill(`orange kettle drifts ${run}`);
  await page.getByLabel("Repeat the vault passphrase").fill(`orange kettle drifts ${run}`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Your recovery code" })).toBeVisible({ timeout: 30_000 });
  const code = (await page.getByTestId("recovery-code").textContent())!.trim();
  expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){5}[0-9A-HJKMNP-TV-Z]{5}$/);
  await page.getByLabel("Type the code to confirm you saved it").fill("WRONG-CODE");
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByRole("alert")).toContainText("does not match");
  await page.getByLabel("Type the code to confirm you saved it").fill(code.toLowerCase());
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByTestId("home-empty")).toContainText("No drawers yet.");
  await axe(page);
  // the join link is single-use
  await page.goto(`/join#${token}`);
  await expect(page.getByRole("alert")).toContainText("invalid or already used");
  // reload within 24 h: still unlocked, no prompt
  await page.goto("/");
  await expect(page.getByTestId("home-empty")).toBeVisible();
  // IndexedDB holds a CryptoKey handle, never bytes
  const idb = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open("petty", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rec = await new Promise<{ ecdhPrivate: CryptoKey; expiresAt: number }>((res, rej) => { const r = db.transaction("kv").objectStore("kv").get("session.unlocked"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return { isKey: rec.ecdhPrivate instanceof CryptoKey, extractable: rec.ecdhPrivate.extractable, expiresInHours: (rec.expiresAt - Date.now()) / 3_600_000 };
  });
  expect(idb.isKey).toBe(true);
  expect(idb.extractable).toBe(false);
  expect(idb.expiresInHours).toBeGreaterThan(23);
});

test("login, wrong passphrase, unlock, Lock now, sign out — in English and in Polish", async ({ page }) => {
  const user = await signupViaApi("erin");
  await page.goto("/login");
  await axe(page);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong email or password");
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await axe(page);
  // password-manager hints: a hidden "email · vault" username and current-password on the passphrase field
  await expect(page.getByTestId("vault-username")).toHaveValue(`${user.email} · vault`);
  await expect(page.getByLabel("Vault passphrase", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  await page.getByLabel("Vault passphrase").fill("definitely wrong passphrase");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toContainText("did not open the vault");
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  // settings: safety number, Lock now
  await openSettings(page);
  await axe(page);
  await expect(page.getByTestId("safety-number")).toHaveText(/^(\d{5} ){5}\d{5}$/);
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible(); // still locked after reload
  // Polish
  await page.getByLabel("Vault passphrase").fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await openSettings(page);
  await page.getByLabel("Language").selectOption("pl");
  await expect(page.getByRole("heading", { name: "Ustawienia" })).toBeVisible();
  await page.getByRole("button", { name: "Zablokuj teraz" }).click();
  await expect(page.getByRole("heading", { name: "Odblokuj sejf" })).toBeVisible();
  await page.getByLabel("Hasło sejfu").fill("złe hasło sejfu");
  await page.getByRole("button", { name: "Odblokuj" }).click();
  await expect(page.getByRole("alert")).toContainText("nie otworzyło sejfu");
  await page.getByLabel("Hasło sejfu").fill(user.passphrase);
  await page.getByRole("button", { name: "Odblokuj" }).click();
  await expect(page.getByTestId("home-empty")).toContainText("Brak szuflad.");
  await axe(page);
  // sign out lives on the home screen, asks once, and drops the visitor on the front page
  await page.getByTestId("account-menu").click();
  await page.getByTestId("menu-sign-out").click();
  const bye = page.getByRole("dialog");
  await expect(bye.getByRole("heading", { name: "Wylogować?" })).toBeVisible();
  await bye.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // the sheet slides in at partial opacity; axe must sample the settled colours
  await axe(page);
  await bye.getByRole("button", { name: "Wyloguj" }).click();
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible(); // visitors now land on the marketing page
  await expect(page).toHaveURL(/\/$/);
  // SR-8: sign-out wipes the ciphertext cache and the outbox; only the tamper-detection heads may remain
  const idbKeys = () => page.evaluate(() => new Promise<string[]>((resolve) => { const r = indexedDB.open("petty", 1); r.onsuccess = () => { const t = r.result.transaction("kv", "readonly").objectStore("kv").getAllKeys(); t.onsuccess = () => resolve(t.result.map(String)); }; r.onerror = () => resolve(["error"]); }));
  await expect.poll(async () => (await idbKeys()).filter((k) => !k.startsWith("head."))).toEqual([]);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Zaloguj się" })).toBeVisible(); // the session is really gone
});

test("modal sheet traps focus and closes on Escape", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Email")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Send reset link" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Email")).toBeFocused(); // last → first: the trap wraps
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Forgot your password?" })).toBeFocused(); // focus returned
});

test("two users in two contexts are both unlocked and independent", async ({ alice, bob }) => {
  await expect(alice.page.getByTestId("home-empty")).toBeVisible();
  await expect(bob.page.getByTestId("home-empty")).toBeVisible();
  await openSettings(alice.page);
  await openSettings(bob.page);
  // The safety number is derived asynchronously after the screen mounts: wait for it, do not read it once (it was "" for both under load).
  const digits = /^(\d{5} ){5}\d{5}$/;
  await expect(alice.page.getByTestId("safety-number")).toHaveText(digits);
  await expect(bob.page.getByTestId("safety-number")).toHaveText(digits);
  const a = await alice.page.getByTestId("safety-number").textContent();
  const b = await bob.page.getByTestId("safety-number").textContent();
  expect(a).not.toEqual(b);
});

test("a session revoked on the server signs the client out on its next call, without a reload", async ({ page }) => {
  const user = await signupViaApi("ghosted");
  await loginAndUnlock(page, user);
  await openSettings(page);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // the server forgets the session (admin "sign out everywhere", expiry, blocking — same effect)
  const c = new pg.Client({ connectionString: OWNER_DB });
  await c.connect();
  try { await c.query("delete from sessions where user_id = (select id from users where email = $1)", [user.email]); } finally { await c.end(); }
  // cached screens may still render, but the first API call must end the local session
  await page.getByRole("button", { name: "Create join link" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // and the vault cache is gone with it
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("landing (PETTY-108): a visitor has a way in — sign in first, an invite second, and the call to action repeats down the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible();
  // Local mode is invite-only: Sign in is the primary, Get an invite a real button (a mailto link), three times on the page.
  await expect(page.getByTestId("landing-signin")).toHaveCount(3);
  const invite = page.getByTestId("landing-invite");
  await expect(invite).toHaveCount(3);
  await expect(invite.first()).toHaveAttribute("href", /^mailto:/);
  await expect(page.getByText("invite-only")).toBeVisible();
  // PETTY-109: a screenshot opens full size in an overlay; Escape closes it and focus returns to the frame.
  await page.getByRole("button", { name: /^Enlarge: Home screen/ }).click();
  const overlay = page.getByTestId("shot-overlay");
  await expect(overlay).toBeVisible();
  // PETTY-142: the backdrop covers the whole window, not the page's 480 px column
  const vw = page.viewportSize()!.width;
  expect((await overlay.boundingBox())!.width).toBeGreaterThanOrEqual(vw - 1);
  await expect(overlay.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(overlay.getByText("2/5")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Enlarge: Home screen/ })).toBeFocused();
  await page.getByTestId("landing-signin").first().click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("not found (PETTY-110): a wrong URL says so and leads home; signed in it leads to the drawers", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByTestId("not-found")).toHaveText("This page does not exist");
  await page.getByRole("button", { name: "Go to the home page" }).click();
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible();
  const user = await signupViaApi("lost");
  await loginAndUnlock(page, user);
  await page.goto("/drawers/not-a-real-id/whatever");
  await page.getByRole("button", { name: "Go to my drawers" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
});

test("sign in page (PETTY-111): a visitor without an account can ask for an invite, read what Petty is, or go back", async ({ page }) => {
  await page.goto("/login");
  const box = page.getByTestId("login-no-account");
  await expect(box.getByRole("link", { name: "Get an invite" })).toHaveAttribute("href", /^mailto:/);
  await box.getByRole("button", { name: "What is Petty?" }).click();
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible();
  await page.goto("/login");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Petty", level: 1 })).toBeVisible();
});

test("invalid join link (PETTY-128): says why, and offers sign in or the landing page", async ({ page }) => {
  await page.goto("/join#not-a-real-token");
  await expect(page.getByRole("alert")).toHaveText("This join link is invalid or already used.");
  await expect(page.getByText("Ask the person who invited you")).toBeVisible();
  await page.getByTestId("join-invalid-next").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
