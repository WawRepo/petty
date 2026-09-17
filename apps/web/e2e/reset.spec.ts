/** Phase 15a: forgot → mail (Mailpit) → new login password → sign in; the vault passphrase is untouched. */
import { expect, signupViaApi, test } from "./fixtures.js";

const MAILPIT = process.env["MAILPIT_URL"] ?? "http://localhost:8025";

async function resetLinkFor(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const list = (await r.json()) as { messages: Array<{ ID: string; Subject: string }> };
    const m = list.messages.find((x) => /reset/i.test(x.Subject));
    if (m) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { Text: string };
      const link = /https?:\/\/\S+\/reset[#/][A-Za-z0-9_-]+/.exec(msg.Text)?.[0];
      if (link) return link;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error("no reset mail in Mailpit");
}

test("forgot password sends a mail; the link sets a new login password; the vault still opens with the old passphrase", async ({ page }) => {
  const user = await signupViaApi("forgetful");
  await page.goto("/login");
  await page.getByRole("button", { name: /Forgot/ }).click();
  await page.getByRole("dialog").getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByTestId("reset-sent")).toBeVisible();
  const link = await resetLinkFor(user.email);
  const u = new URL(link);
  await page.goto(u.pathname + u.hash); // the token rides in the fragment (SR-9); the path form still works for old mails
  await page.getByLabel("New login password").fill("a-brand-new-password");
  await page.getByLabel("Repeat the new password").fill("a-brand-new-password");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.locator(".toast")).toHaveText("Login password changed. Sign in with the new one.");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Login password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong email or password");
  await page.getByLabel("Login password").fill("a-brand-new-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Vault passphrase", { exact: true }).fill(user.passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("home-empty")).toBeVisible();
  // the used link is dead
  const u2 = new URL(link);
  await page.goto(u2.pathname + u2.hash);
  await page.getByLabel("New login password").fill("another-password-9");
  await page.getByLabel("Repeat the new password").fill("another-password-9");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid, used or older");
});
